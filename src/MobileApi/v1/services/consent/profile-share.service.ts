import crypto from "crypto";
import { In } from "typeorm/index.js";
import { AppDataSource } from "../../../../config/database.js";
import { PatientProfileShareLink } from "../../../../models/Consent/profile-share-link.model.js";
import { User } from "../../../../models/Account/user.model.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { isFamilyLinked } from "../../../../middlewares/request-identity.js";

/** How long a link stays open. */
const DURATIONS: Record<string, { days: number; label: string }> = {
    "1_DAY": { days: 1, label: "1 day" },
    "7_DAYS": { days: 7, label: "7 days" },
    "30_DAYS": { days: 30, label: "30 days" },
};

const MAX_ACTIVE_LINKS = 10;

export class ShareLinkError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const fullName = (u?: Partial<User> | null) => `${u?.FirstName ?? ""} ${u?.LastName ?? ""}`.trim();

const doctorName = (u?: Partial<User> | null) => {
    const name = fullName(u);
    if (!name) return null;
    return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
};

const clean = (v?: string | null) => {
    const t = (v ?? "").trim();
    return t && t !== "--" && t.toLowerCase() !== "null" ? t : null;
};

function webBaseUrl(): string {
    const base = process.env.FRONTEND_URL || process.env.CLIENT_URL || "http://localhost:5173";
    return base.endsWith("/") ? base.slice(0, -1) : base;
}

export class ProfileShareService {
    private linkRepo = AppDataSource.getRepository(PatientProfileShareLink);
    private userRepo = AppDataSource.getRepository(User);

    private async assertCanShare(requesterId: string, patientId: string) {
        if (!requesterId) throw new ShareLinkError("Sign in to share a profile.", 401);
        if (!(await isFamilyLinked(requesterId, patientId))) {
            throw new ShareLinkError("You can only share your own profile or a family member's.", 403);
        }
    }

    private toListItem(link: PatientProfileShareLink) {
        const now = new Date();
        const status = link.RevokedAt ? "REVOKED" : link.ExpiresAt < now ? "EXPIRED" : "ACTIVE";
        return {
            id: link.Id,
            patientId: link.PatientId,
            label: link.Label ?? null,
            status,
            createdAt: link.CreatedAt,
            expiresAt: link.ExpiresAt,
            revokedAt: link.RevokedAt ?? null,
            viewCount: link.ViewCount,
            lastViewedAt: link.LastViewedAt ?? null,
        };
    }

    /** Creates a link. The full URL is returned only here; it cannot be read back later. */
    async createLink(requesterId: string, patientId: string, duration: string, label?: string) {
        await this.assertCanShare(requesterId, patientId);
        const option = DURATIONS[String(duration || "").toUpperCase()];
        if (!option) throw new ShareLinkError("Choose how long the link stays open: 1 day, 7 days or 30 days.");

        const patient = await this.userRepo.findOne({ where: { Id: patientId, IsDeleted: false } });
        if (!patient) throw new ShareLinkError("Profile not found.", 404);

        const active = await this.linkRepo
            .createQueryBuilder("l")
            .where("l.PatientId = :patientId", { patientId })
            .andWhere("l.RevokedAt IS NULL")
            .andWhere("l.ExpiresAt > GETDATE()")
            .getCount();
        if (active >= MAX_ACTIVE_LINKS) {
            throw new ShareLinkError(`You already have ${MAX_ACTIVE_LINKS} open links. Turn one off before making another.`);
        }

        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + option.days * 24 * 60 * 60 * 1000);
        const saved = await this.linkRepo.save(
            this.linkRepo.create({
                PatientId: patientId,
                CreatedByUserId: requesterId,
                TokenHash: hashToken(token),
                Label: clean(label)?.slice(0, 120) ?? null,
                ExpiresAt: expiresAt,
                ViewCount: 0,
            }),
        );
        return { ...this.toListItem(saved), durationLabel: option.label, url: `${webBaseUrl()}/shared-profile/${token}` };
    }

    async listLinks(requesterId: string, patientId: string) {
        await this.assertCanShare(requesterId, patientId);
        const links = await this.linkRepo.find({ where: { PatientId: patientId }, order: { CreatedAt: "DESC" }, take: 50 });
        return links.map((l) => this.toListItem(l));
    }

    async revokeLink(requesterId: string, linkId: number) {
        const link = await this.linkRepo.findOne({ where: { Id: linkId } });
        if (!link) throw new ShareLinkError("Link not found.", 404);
        await this.assertCanShare(requesterId, link.PatientId);
        if (!link.RevokedAt) {
            link.RevokedAt = new Date();
            await this.linkRepo.save(link);
        }
        return this.toListItem(link);
    }

    /**
     * What a doctor sees through a link: the same records the patient sees in
     * the app. Doctors' private clinical notes are not included.
     */
    async getSharedProfile(token: string) {
        if (!token || token.length < 20 || token.length > 100) throw new ShareLinkError("This link is not valid.", 404);
        const link = await this.linkRepo.findOne({ where: { TokenHash: hashToken(token) } });
        if (!link) throw new ShareLinkError("This link is not valid.", 404);
        if (link.RevokedAt) throw new ShareLinkError("The patient has turned this link off.", 410);
        if (link.ExpiresAt < new Date()) throw new ShareLinkError("This link has expired. Ask the patient for a new one.", 410);

        const patientId = link.PatientId;
        const patient = await this.userRepo.findOne({ where: { Id: patientId, IsDeleted: false } });
        if (!patient) throw new ShareLinkError("This profile is no longer available.", 410);

        link.ViewCount = (link.ViewCount ?? 0) + 1;
        link.LastViewedAt = new Date();
        await this.linkRepo.save(link);

        return { sharedAt: link.CreatedAt, expiresAt: link.ExpiresAt, ...(await this.buildPatientBundle(patient)) };
    }

    /**
     * Everything the app holds about a patient, newest first: details,
     * visits, records, prescriptions, documents, medicines, notes, diet and
     * fitness. Doctors' private clinical notes are not included.
     *
     * With [hospitalId], only that hospital's own records are returned, and
     * the patient's self-entered data (medicines, fitness, uploaded record
     * files) is left out. [excludeAppointmentId] drops the visit being viewed.
     */
    async buildPatientBundle(patient: User, opts: { hospitalId?: number; excludeAppointmentId?: number } = {}) {
        const patientId = patient.Id;
        const { PatientMedicalRecord } = await import("../../../../models/Appointments/patient-medical-record.model.js");
        const { PatientPrescription } = await import("../../../../models/Appointments/patient-prescription.model.js");
        const { MedicalDocument } = await import("../../../../models/Appointments/medical-document.model.js");
        const { Appointment } = await import("../../../../models/Appointments/appointment.model.js");

        const [records, prescriptions, documents, appointments] = await Promise.all([
            AppDataSource.getRepository(PatientMedicalRecord).find({
                where: { PatientId: patientId },
                relations: ["Doctor"],
                order: { Date: "DESC", CreatedAt: "DESC" },
                take: 200,
            }),
            AppDataSource.getRepository(PatientPrescription).find({
                where: { PatientId: patientId },
                relations: ["Diagnoses", "Medications", "Doctor", "LabTests"],
                order: { CreatedAt: "DESC" },
                take: 200,
            }),
            AppDataSource.getRepository(MedicalDocument).find({
                where: { PatientId: patientId, IsDeleted: false },
                order: { CreatedAt: "DESC" },
                take: 200,
            }),
            AppDataSource.getRepository(Appointment).find({
                where: { UserId: patientId },
                relations: ["Doctor"],
                order: { AppointmentDate: "DESC" },
                take: 100,
            }),
        ]);

        const { ClinicalNote } = await import("../../../../models/Appointments/clinical-note.model.js");
        const { DoctorSuggestion } = await import("../../../../models/Appointments/doctor-suggestion.model.js");
        const { PatientMedicationReminder } = await import("../../../../models/Appointments/patient-medication-reminder.model.js");
        const { PostVisitDocument } = await import("../../../../models/Appointments/post-visit-document.model.js");
        const { MedicalRecord } = await import("../../../../models/Appointments/medical-record.model.js");
        const { PatientDietPlan } = await import("../../../../models/Diet/patient-diet-plan.model.js");
        const { PatientFitnessData } = await import("../../../../models/Fitness/patient-fitness.model.js");
        const { PatientInsurance } = await import("../../../../models/Organizations/patient-insurance.model.js");

        // Each source is optional: one failing table must not hide the rest.
        const safe = async <T>(work: Promise<T[]>): Promise<T[]> => {
            try {
                return await work;
            } catch (e: any) {
                console.error("[ProfileShare] Skipped a section:", e?.message);
                return [];
            }
        };
        const [notes, suggestions, reminders, visitDocs, recordFiles, dietPlans, fitness, insurances] = await Promise.all([
            safe(AppDataSource.getRepository(ClinicalNote).find({ where: { PatientId: patientId } as any, relations: ["Doctor"], order: { CreatedAt: "DESC" }, take: 100 })),
            safe(AppDataSource.getRepository(DoctorSuggestion).find({ where: { PatientId: patientId } as any, relations: ["Doctor"], order: { CreatedAt: "DESC" }, take: 100 })),
            safe(AppDataSource.getRepository(PatientMedicationReminder).find({ where: { UserId: patientId } as any, order: { CreatedAt: "DESC" }, take: 100 })),
            safe(AppDataSource.getRepository(PostVisitDocument).find({ where: { PatientId: patientId, IsDeleted: false } as any, order: { CreatedAt: "DESC" }, take: 100 })),
            safe(AppDataSource.getRepository(MedicalRecord).find({ where: { PatientId: patientId } as any, order: { CreatedAt: "DESC" }, take: 100 })),
            safe(AppDataSource.getRepository(PatientDietPlan).find({ where: { PatientId: patientId } as any, relations: ["Meals", "AssignedByDoctor"], order: { CreatedAt: "DESC" }, take: 20 })),
            safe(
                AppDataSource.getRepository(PatientFitnessData)
                    .createQueryBuilder("f")
                    .where("f.PatientId = :patientId", { patientId })
                    // The 30 most recent days on record, however long ago the last sync was.
                    .orderBy("f.Date", "DESC")
                    .take(30)
                    .getMany(),
            ),
            safe(AppDataSource.getRepository(PatientInsurance).find({ where: { UserId: patientId, IsDeleted: false } as any, relations: ["Organization"], take: 20 })),
        ]);

        const scoped = <T>(rows: T[]): T[] =>
            opts.hospitalId ? rows.filter((r: any) => Number(r.HospitalId) === Number(opts.hospitalId)) : rows;
        // Cancelled and rejected bookings never happened, so they aren't past visits.
        const visits = scoped(appointments)
            .filter((a: any) => !["cancelled", "canceled", "rejected"].includes(String(a.Status || "").toLowerCase()))
            .filter((a: any) => !opts.excludeAppointmentId || Number(a.Id) !== Number(opts.excludeAppointmentId));
        const ownData = <T>(rows: T[]): T[] => (opts.hospitalId ? [] : rows);

        const hospitalIds = [
            ...new Set(
                [...records, ...prescriptions, ...documents, ...appointments, ...notes, ...suggestions, ...visitDocs, ...dietPlans, ...insurances]
                    .map((r: any) => Number(r.HospitalId))
                    .filter((id) => id > 0),
            ),
        ];
        const hospitals = hospitalIds.length
            ? await AppDataSource.getRepository(Hospital).find({ where: { Id: In(hospitalIds) } as any })
            : [];
        const hospitalName = (id?: number | null) => (id ? hospitals.find((h: any) => Number(h.Id) === Number(id))?.Name ?? null : null);

        // Latest value of each vital, with the date it was taken.
        const vitalKeys = [
            ["bloodPressure", "BloodPressure", "mmHg"],
            ["heartRate", "HeartRate", "bpm"],
            ["temperature", "Temperature", "°F"],
            ["spo2", "SpO2", "%"],
            ["weight", "Weight", "kg"],
            ["height", "Height", "cm"],
        ] as const;
        const vitals: Record<string, { value: string; unit: string; date: Date }> = {};
        for (const [key, field, unit] of vitalKeys) {
            const r = scoped(records).find((rec: any) => clean(rec[field]));
            if (r) vitals[key] = { value: clean((r as any)[field])!, unit, date: r.Date };
        }

        const parseList = (raw?: string | null): string[] => {
            if (!raw) return [];
            try {
                const v = JSON.parse(raw);
                return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
            } catch {
                return raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
            }
        };
        const today = new Date().toISOString().slice(0, 10);
        const dateKey = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : "");
        const heightCm = Number(patient.Height) || null;
        const weightKg = Number(patient.Weight) || null;
        const bmi = heightCm && weightKg ? Math.round((weightKg / Math.pow(heightCm / 100, 2)) * 10) / 10 : null;
        const address = patient.PermanentAddressId
            ? await AppDataSource.getRepository((await import("../../../../models/Account/address.model.js")).Address)
                  .findOne({ where: { Id: patient.PermanentAddressId } })
                  .catch(() => null)
            : null;

        return {
            patient: {
                name: fullName(patient) || "Patient",
                gender: clean(patient.Gender),
                dateOfBirth: clean(patient.DateOfBirth),
                bloodGroup: clean(patient.BloodGroup),
                phone: clean(patient.PhoneNumber),
                email: clean(patient.Email),
                photoUrl: clean(patient.ImagePath)?.startsWith("http") ? clean(patient.ImagePath) : null,
                heightCm,
                weightKg,
                bmi,
                address: address ? [address.City, address.State].map((x: any) => clean(x)).filter(Boolean).join(", ") || null : null,
                emergencyContact: clean((patient as any).EmergencyContactName)
                    ? {
                          name: clean((patient as any).EmergencyContactName),
                          relation: clean((patient as any).EmergencyContactRelation),
                          phone: clean((patient as any).EmergencyContactPhone),
                      }
                    : null,
                insurances: insurances.map((i: any) => ({
                    provider: clean(i.InsuranceProvider),
                    number: clean(i.InsuranceNumber),
                    active: i.Status !== false,
                })),
            },
            medicines: ownData(reminders).map((r: any) => {
                let times: string[] = [];
                try {
                    times = JSON.parse(r.TimesJson || "[]");
                } catch {}
                const ended = !r.IsContinuous && r.EndDate && dateKey(r.EndDate) < today;
                return {
                    name: clean(r.MedicineName),
                    dosage: clean(r.Dosage),
                    instructions: clean(r.Instructions),
                    mealRelation: clean(r.MealRelation),
                    times,
                    startDate: r.StartDate ?? null,
                    endDate: r.IsContinuous ? null : r.EndDate ?? null,
                    continuous: !!r.IsContinuous,
                    condition: clean(r.Condition),
                    doctor: clean(r.DoctorName) ? doctorName({ FirstName: r.DoctorName } as any) : null,
                    active: !!r.IsActive && !ended,
                };
            }),
            doctorNotes: scoped(notes)
                .filter((n: any) => clean(n.Notes))
                .map((n: any) => ({ date: n.CreatedAt, note: clean(n.Notes), doctor: doctorName(n.Doctor), hospital: hospitalName(n.HospitalId) })),
            suggestions: scoped(suggestions).map((s: any) => ({
                date: s.CreatedAt,
                title: clean(s.Title),
                description: clean(s.Description),
                fileUrl: clean(s.FilePath)?.startsWith("http") ? clean(s.FilePath) : null,
                fileName: clean(s.FileName),
                doctor: doctorName(s.Doctor),
                hospital: hospitalName(s.HospitalId),
            })),
            dietPlans: scoped(dietPlans).map((d: any) => ({
                name: clean(d.PlanName) ?? "Diet plan",
                condition: clean(d.Condition),
                status: clean(d.Status),
                dietType: clean(d.DietType),
                startDate: d.StartDate ?? null,
                endDate: d.EndDate ?? null,
                totalDays: d.TotalDays ?? 1,
                targetCalories: d.TargetCalories ?? null,
                targetProteinG: d.TargetProteinG ?? null,
                targetCarbsG: d.TargetCarbsG ?? null,
                targetFatG: d.TargetFatG ?? null,
                doctorNotes: clean(d.DoctorNotes),
                foodsToAvoid: parseList(d.FoodsToAvoid),
                foodsToPrefer: parseList(d.FoodsToPrefer),
                madeByPatient: !!d.CreatedByPatient,
                doctor: d.CreatedByPatient ? null : doctorName(d.AssignedByDoctor),
                hospital: hospitalName(d.HospitalId),
                meals: (d.Meals ?? [])
                    .slice()
                    .sort((a: any, b: any) => a.DayNumber - b.DayNumber || (a.SortOrder ?? 0) - (b.SortOrder ?? 0))
                    .map((m: any) => ({
                        day: m.DayNumber,
                        slot: clean(m.MealSlot),
                        time: clean(m.MealTime),
                        food: clean(m.FoodName),
                        quantity: m.Quantity ?? null,
                        unit: clean(m.Unit),
                        calories: m.Calories ?? null,
                        notes: clean(m.Notes),
                    })),
            })),
            // Health Connect stores 0 for "not measured"; send those as missing.
            fitness: ownData(fitness).map((f: any) => ({
                date: f.Date,
                steps: f.Steps ?? null,
                calories: f.Calories ?? null,
                distanceKm: f.DistanceMeters ? Math.round(f.DistanceMeters / 100) / 10 : null,
                activeMinutes: f.ActiveMinutes ?? null,
                sleepMinutes: f.SleepMinutes || null,
                heartRateAvg: f.HeartRateAvg || null,
                restingHeartRate: f.RestingHeartRate || null,
                bloodOxygen: f.BloodOxygen || null,
                bloodPressure: f.BloodPressureSys && f.BloodPressureDia ? `${f.BloodPressureSys}/${f.BloodPressureDia}` : null,
                weightKg: f.WeightKg || null,
                bloodGlucose: f.BloodGlucoseMgDl || null,
                source: clean(f.Source),
            })),
            vitals,
            appointments: visits.map((a: any) => ({
                id: a.Id,
                date: a.AppointmentDate,
                time: a.StartTime ?? null,
                status: a.Status ?? null,
                type: a.IsTeleConsultation ? "Video" : a.AppointmentType ?? "Consultation",
                reason: clean(a.Reason) ?? clean(a.ChiefComplaint),
                doctor: doctorName(a.Doctor),
                hospital: hospitalName(a.HospitalId),
            })),
            medicalRecords: scoped(records).map((r: any) => ({
                date: r.Date,
                type: clean(r.Type),
                chiefComplaint: clean(r.ChiefComplaint),
                symptoms: clean(r.Symptoms),
                examination: clean(r.PhysicalExamination),
                diagnosis: clean(r.Diagnosis),
                treatment: clean(r.Treatment),
                followUpDate: r.FollowUpDate ?? null,
                vitals: {
                    bloodPressure: clean(r.BloodPressure),
                    heartRate: clean(r.HeartRate),
                    temperature: clean(r.Temperature),
                    spo2: clean(r.SpO2),
                    weight: clean(r.Weight),
                    height: clean(r.Height),
                },
                // Self-reported entries are stored with the patient as the "doctor".
                doctor: String(r.DoctorId ?? "").toUpperCase() === patientId.toUpperCase() ? null : doctorName(r.Doctor),
                hospital: hospitalName(r.HospitalId),
            })),
            prescriptions: scoped(prescriptions).map((p: any) => ({
                date: p.Date ?? p.CreatedAt,
                doctor: doctorName(p.Doctor),
                hospital: hospitalName(p.HospitalId),
                notes: clean(p.Notes),
                pdfUrl: clean(p.PdfUrl),
                diagnoses: (p.Diagnoses ?? []).map((d: any) => clean(d.Diagnosis)).filter(Boolean),
                medications: (p.Medications ?? []).map((m: any) => ({
                    name: clean(m.Medication),
                    dosage: clean(m.Dosage),
                    frequency: clean(m.FrequencyType),
                    duration: m.DurationValue ? `${m.DurationValue} ${m.DurationUnit ?? "days"}` : null,
                    route: clean(m.Route),
                    instructions: clean(m.Instructions),
                })),
                labTests: (p.LabTests ?? []).map((t: any) => ({
                    testName: clean(t.TestName),
                    category: clean(t.Category),
                    priority: clean(t.Priority),
                    instructions: clean(t.Instructions),
                })),
            })),
            documents: [
                ...scoped(documents).map((d: any) => ({
                name: clean(d.OriginalFileName) ?? clean(d.FileName) ?? "Document",
                category: clean(d.DocumentCategory),
                type: clean(d.DocumentType),
                description: clean(d.Description),
                date: d.CreatedAt,
                url: clean(d.BlobUrl),
                mimeType: clean(d.MimeType),
                hospital: hospitalName(d.HospitalId),
                })),
                ...scoped(visitDocs).map((d: any) => ({
                    name: clean(d.FileName) ?? "Visit summary",
                    category: "Visit summary",
                    type: clean(d.DocumentType),
                    description: null,
                    date: d.GeneratedAt ?? d.CreatedAt,
                    url: clean(d.BlobUrl),
                    mimeType: clean(d.MimeType),
                    hospital: hospitalName(d.HospitalId),
                })),
                ...ownData(recordFiles)
                    .filter((r: any) => clean(r.FileUrl))
                    .map((r: any) => ({
                        name: clean(r.RecordType) ?? "Medical record",
                        category: "Medical record",
                        type: clean(r.RecordType),
                        description: null,
                        date: r.CreatedAt,
                        url: clean(r.FileUrl),
                        mimeType: null,
                        hospital: null,
                    })),
            ].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()),
        };
    }
}

export const profileShareService = new ProfileShareService();
