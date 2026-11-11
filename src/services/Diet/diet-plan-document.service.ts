import { AppDataSource } from "../../config/database.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { blobService } from "../Common/blob.service.js";
import { isSystemAdmin } from "../../utils/hospital-admin-access.js";
import { patientDietPlanService } from "./patient-diet-plan.service.js";
import { dietPlanPdfService, pdfText, type DietPlanPdfInput, type DietPlanPdfMeal } from "./diet-plan-pdf.service.js";

/** Category of the PDFs saved to a patient's documents when a doctor prescribes or changes a diet plan. */
export const DIET_PLAN_DOCUMENT_CATEGORY = "Diet Plan";

type Plan = NonNullable<Awaited<ReturnType<typeof patientDietPlanService.getPlanDetails>>>;

const sameId = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());
const positive = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** "YYYY-MM-DD" of a date column. Dates come back as local times (the driver doesn't use UTC), so local parts are the stored day. */
function localDate(value?: Date | string | null): string | undefined {
    if (!value) return undefined;
    if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
    if (Number.isNaN(value.getTime())) return undefined;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function ageFrom(dateOfBirth?: Date | string | null): number | undefined {
    if (!dateOfBirth) return undefined;
    const birth = new Date(dateOfBirth);
    if (Number.isNaN(birth.getTime())) return undefined;
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
    return age >= 0 && age < 150 ? age : undefined;
}

const fmt = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));

/** "2 bowl"; a serving that already has an amount reads "2 pieces (80g)" for one and "2 x 2 pieces (80g)" for more. Same as the apps. */
function portionOf(quantity: number, unit: string, weightAmount?: number, weightUnit?: string): string {
    const label = unit.trim();
    let portion = fmt(quantity);
    if (label) {
        const single = /^1\s+(\D.*)$/.exec(label);
        if (single) portion = `${fmt(quantity)} ${single[1]}`;
        else if (/^\d/.test(label)) portion = quantity === 1 ? label : `${fmt(quantity)} x ${label}`;
        else portion = `${fmt(quantity)} ${label}`;
    }
    const weight = weightAmount && weightAmount > 0 ? `${fmt(weightAmount)} ${(weightUnit || "g").trim()}` : "";
    return weight && !portion.includes(weight.replace(" ", "")) ? `${portion} (${weight})` : portion;
}

/** Entered calories, or an estimate from the macros (4/4/9 kcal per gram) or the linked food. */
function caloriesOf(meal: any): { calories: number; estimated: boolean } {
    const stated = Number(meal.Calories) || 0;
    if (stated > 0) return { calories: Math.round(stated), estimated: false };
    const fromMacros = Math.round((Number(meal.ProteinG) || 0) * 4 + (Number(meal.CarbsG) || 0) * 4 + (Number(meal.FatG) || 0) * 9);
    if (fromMacros > 0) return { calories: fromMacros, estimated: true };
    const perServing = Number(meal.FoodItem?.CaloriesPerServing) || 0;
    const quantity = Number(meal.Quantity) > 0 ? Number(meal.Quantity) : 1;
    return perServing > 0 ? { calories: Math.round(perServing * quantity), estimated: true } : { calories: 0, estimated: false };
}

function parseList(value?: string | null): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {
        // An older plan may hold a plain comma list.
    }
    return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The name shown in document lists, e.g. "Diet Plan - Diabetes care.pdf". */
function documentFileName(planName: string): string {
    const clean = pdfText(planName).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return `Diet Plan - ${clean || "Plan"}.pdf`;
}

export class DietPlanDocumentService {
    /** The hospital the plan belongs to: its own, else the doctor's, else the organization's first. */
    private async hospitalIdFor(plan: Plan): Promise<number | undefined> {
        if (plan.HospitalId) return Number(plan.HospitalId);
        const rows = await AppDataSource.query(
            `SELECT TOP 1 Id FROM (
                SELECT hp.HospitalId AS Id, 0 AS Rank FROM HealthcareProviders hp JOIN Hospitals h ON h.Id = hp.HospitalId
                 WHERE hp.UserId = @0 AND ISNULL(hp.IsDeleted, 0) = 0 AND h.OrganizationId = @1
                UNION ALL
                SELECT u.LatestHospitalId, 1 FROM Users u JOIN Hospitals h ON h.Id = u.LatestHospitalId
                 WHERE u.Id = @0 AND h.OrganizationId = @1
                UNION ALL
                SELECT h.Id, 2 FROM Hospitals h WHERE h.OrganizationId = @1 AND ISNULL(h.IsDeleted, 0) = 0
            ) x WHERE Id IS NOT NULL ORDER BY Rank, Id`,
            [plan.AssignedByDoctorId, plan.OrganizationId]
        );
        return rows[0]?.Id ? Number(rows[0].Id) : undefined;
    }

    private async pdfInput(plan: Plan, hospitalId?: number): Promise<DietPlanPdfInput> {
        const [hospital] = hospitalId
            ? await AppDataSource.query(
                `SELECT TOP 1 Name, Address, City, State, Pincode, HelplineNumber, MobileNumber, Email, Website, ImageUrl FROM Hospitals WHERE Id = @0`,
                [hospitalId]
            )
            : [];
        const [doctor] = plan.AssignedByDoctorId
            ? await AppDataSource.query(
                `SELECT TOP 1 u.FirstName, u.LastName, hp.Qualification, hp.Specialty, hp.Department, hp.RegistrationNumber
                 FROM Users u
                 OUTER APPLY (SELECT TOP 1 * FROM HealthcareProviders p WHERE p.UserId = u.Id AND ISNULL(p.IsDeleted, 0) = 0
                              ORDER BY CASE WHEN p.HospitalId = @1 THEN 0 ELSE 1 END, p.Id DESC) hp
                 WHERE u.Id = @0`,
                [plan.AssignedByDoctorId, hospitalId ?? 0]
            )
            : [];
        const [patient] = await AppDataSource.query(
            `SELECT TOP 1 u.FirstName, u.LastName, u.Gender, u.PhoneNumber, u.DateOfBirth, u.BloodGroup,
                    COALESCE(NULLIF(LTRIM(RTRIM(u.TokenNumber)), ''), reg.TokenNumber) AS TokenNumber
             FROM Users u
             OUTER APPLY (SELECT TOP 1 r.TokenNumber FROM PatientRegistrations r WHERE r.UserId = u.Id AND r.IsDeleted = 0
                          ORDER BY CASE WHEN r.HospitalId = @1 THEN 0 ELSE 1 END, r.Id DESC) reg
             WHERE u.Id = @0`,
            [plan.PatientId, hospitalId ?? 0]
        );

        const meals: DietPlanPdfMeal[] = (plan.Meals ?? []).map((meal: any) => {
            const { calories, estimated } = caloriesOf(meal);
            return {
                dayNumber: Number(meal.DayNumber) || 1,
                slot: text(meal.MealSlot) || "Meal",
                time: text(meal.MealTime),
                food: text(meal.FoodName),
                portion: portionOf(Number(meal.Quantity) || 1, text(meal.Unit) || "serving", positive(meal.WeightAmount), text(meal.WeightUnit)),
                calories,
                estimated,
                proteinG: positive(meal.ProteinG),
                carbsG: positive(meal.CarbsG),
                fatG: positive(meal.FatG),
                notes: text(meal.Notes),
            };
        });

        return {
            hospital: {
                name: text(hospital?.Name),
                address: text(hospital?.Address),
                city: text(hospital?.City),
                state: text(hospital?.State),
                pincode: text(hospital?.Pincode),
                helpline: text(hospital?.HelplineNumber) || text(hospital?.MobileNumber),
                email: text(hospital?.Email),
                website: text(hospital?.Website),
                logoUrl: text(hospital?.ImageUrl),
            },
            doctor: {
                name: [text(doctor?.FirstName), text(doctor?.LastName)].filter(Boolean).join(" "),
                qualification: text(doctor?.Qualification),
                specialty: text(doctor?.Specialty) || text(doctor?.Department),
                registrationNumber: text(doctor?.RegistrationNumber),
            },
            patient: {
                name: [text(patient?.FirstName), text(patient?.LastName)].filter(Boolean).join(" "),
                patientId: text(patient?.TokenNumber),
                age: ageFrom(patient?.DateOfBirth),
                gender: text(patient?.Gender),
                phoneNumber: text(patient?.PhoneNumber),
                bloodGroup: text(patient?.BloodGroup),
            },
            plan: {
                id: plan.Id,
                name: text(plan.PlanName),
                condition: text(plan.Condition),
                description: text(plan.Description),
                dietType: text(plan.DietType),
                prescribedOn: localDate(plan.CreatedAt),
                startDate: localDate(plan.StartDate),
                endDate: localDate(plan.EndDate),
                totalDays: Number(plan.TotalDays) || 1,
                targets: {
                    calories: positive(plan.TargetCalories),
                    proteinG: positive(plan.TargetProteinG),
                    carbsG: positive(plan.TargetCarbsG),
                    fatG: positive(plan.TargetFatG),
                },
                foodsToPrefer: parseList(plan.FoodsToPrefer),
                foodsToAvoid: parseList(plan.FoodsToAvoid),
                doctorNotes: text(plan.DoctorNotes),
                meals,
            },
        };
    }

    /** The plan's PDF, built fresh from what is saved now. Null when there is no such plan. */
    async buildPdf(planId: number): Promise<{ buffer: Buffer; fileName: string; plan: Plan } | null> {
        const plan = await patientDietPlanService.getPlanDetails(planId);
        if (!plan) return null;
        const input = await this.pdfInput(plan, await this.hospitalIdFor(plan));
        const buffer = await dietPlanPdfService.generateDietPlanPdf(input);
        return { buffer, fileName: documentFileName(plan.PlanName), plan };
    }

    /**
     * Builds the PDF of a doctor-prescribed plan and keeps it in the patient's documents: one document per
     * plan, replaced each time the plan changes. Plans patients made for themselves are private, so they
     * are never saved there.
     */
    async saveToDocuments(planId: number): Promise<{ url: string; documentId: number; fileName: string } | null> {
        const plan = await patientDietPlanService.getPlanDetails(planId);
        if (!plan || plan.CreatedByPatient) return null;
        const hospitalId = await this.hospitalIdFor(plan);
        if (!hospitalId) throw new Error(`Diet plan ${planId}: no hospital to file the document under.`);

        const buffer = await dietPlanPdfService.generateDietPlanPdf(await this.pdfInput(plan, hospitalId));
        const fileName = documentFileName(plan.PlanName);

        const [owner] = await AppDataSource.query(`SELECT TOP 1 FirstName, Email FROM Users WHERE Id = @0`, [plan.PatientId]);
        const folder = text(owner?.FirstName || owner?.Email || plan.PatientId).toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "patient";
        // A new name for each version, so nobody is shown an old copy from a cache.
        const url = await blobService.uploadBuffer(buffer, `${folder}/diet-plans/DietPlan_${plan.Id}_${Date.now()}.pdf`, "application/pdf");

        const tag = `diet-plan:${plan.Id}`;
        const now = new Date();
        const description = `Diet plan: ${text(plan.PlanName)}`.slice(0, 500);
        const [existing] = await AppDataSource.query(
            `SELECT TOP 1 Id FROM MedicalDocuments
             WHERE PatientId = @0 AND DocumentCategory = @1 AND Tags = @2 AND ISNULL(IsDeleted, 0) = 0
             ORDER BY Id DESC`,
            [plan.PatientId, DIET_PLAN_DOCUMENT_CATEGORY, tag]
        );

        if (existing) {
            await AppDataSource.query(
                `UPDATE MedicalDocuments
                 SET BlobUrl = @0, FileSize = @1, FileName = @2, OriginalFileName = @2, Description = @3, UpdatedAt = @4
                 WHERE Id = @5`,
                [url, buffer.length, fileName, description, now, existing.Id]
            );
            return { url, documentId: Number(existing.Id), fileName };
        }

        const document = new MedicalDocument();
        document.PatientId = String(plan.PatientId);
        document.AppointmentId = plan.AppointmentId ? Number(plan.AppointmentId) : undefined;
        document.DoctorId = plan.AssignedByDoctorId ? String(plan.AssignedByDoctorId) : undefined;
        document.OrganizationId = Number(plan.OrganizationId);
        document.HospitalId = hospitalId;
        document.DocumentCategory = DIET_PLAN_DOCUMENT_CATEGORY;
        document.DocumentType = DIET_PLAN_DOCUMENT_CATEGORY;
        document.FileName = fileName;
        document.OriginalFileName = fileName;
        document.BlobUrl = url;
        document.MimeType = "application/pdf";
        document.FileExtension = ".pdf";
        document.FileSize = buffer.length;
        document.Description = description;
        document.Tags = tag;
        document.UploadedSource = "System";
        document.IsSystemGenerated = true;
        document.CreatedAt = now;
        document.CreatedBy = plan.AssignedByDoctorId ? String(plan.AssignedByDoctorId) : undefined;
        const saved = await AppDataSource.getRepository(MedicalDocument).save(document);
        return { url, documentId: Number(saved.Id), fileName };
    }

    /** Same as [saveToDocuments], but a failure is logged instead of thrown, so saving the plan still succeeds. */
    async saveToDocumentsQuietly(planId: number) {
        try {
            return await this.saveToDocuments(planId);
        } catch (error) {
            console.error(`[DietPlanDocument] Could not save the PDF of diet plan ${planId}:`, error);
            return null;
        }
    }

    /**
     * Staff who may open a prescribed plan's PDF: the doctor who prescribed it, system admins, and anyone
     * with a staff role or a doctor profile in the plan's organization (the diet APIs are scoped by organization).
     */
    async canStaffOpen(userId: string | undefined, plan: Plan): Promise<boolean> {
        if (!userId || plan.CreatedByPatient) return false;
        if (sameId(plan.AssignedByDoctorId, userId)) return true;
        if (await isSystemAdmin(userId)) return true;
        const rows = await AppDataSource.query(
            `SELECT TOP 1 1 AS ok FROM UserRoles ur JOIN Roles r ON r.Id = ur.RoleId
             LEFT JOIN Hospitals h ON h.Id = ur.HospitalId
             WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND ISNULL(ur.Status, 1) = 1 AND r.RoleName NOT LIKE '%Patient%'
               AND (ur.OrganizationId = @1 OR h.OrganizationId = @1)
             UNION ALL
             SELECT TOP 1 1 FROM HealthcareProviders hp JOIN Hospitals h ON h.Id = hp.HospitalId
             WHERE hp.UserId = @0 AND ISNULL(hp.IsDeleted, 0) = 0 AND h.OrganizationId = @1`,
            [userId, plan.OrganizationId]
        );
        return rows.length > 0;
    }
}

export const dietPlanDocumentService = new DietPlanDocumentService();
