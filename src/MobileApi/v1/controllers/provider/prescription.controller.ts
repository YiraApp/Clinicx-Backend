import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { patientPrescriptionService } from "../../../../services/Appointments/patient-prescription.service.js";
import { pushNotificationService } from "../../../../services/Notifications/push-notification.service.js";
import { AppDataSource } from "../../../../config/database.js";
import { User } from "../../../../models/Account/user.model.js";
import { ApiResponse } from "../../../../utils/response.utils.js";
import { prescriptionPdfService } from "../../../../services/Prescriptions/prescription-pdf.service.js";
import { blobService } from "../../../../services/Common/blob.service.js";
import { Hospital } from "../../../../models/Organizations/hospital.model.js";
import { HealthcareProvider } from "../../../../models/Organizations/healthcare-provider.model.js";
import { MedicalDocument } from "../../../../models/Appointments/medical-document.model.js";
import { medicalDocumentRepository } from "../../../../repositories/Appointments/medical-document.repository.js";
import { PatientPrescription } from "../../../../models/Appointments/patient-prescription.model.js";
import { normalizeLabTests } from "../../../../utils/prescription-lab-tests.utils.js";
import { sortMedications } from "../../../../utils/prescription-medications.js";

const normalizeMedication = (med: any) => {
    let durVal: number | undefined = undefined;
    if (typeof med.durationValue === "number" && !isNaN(med.durationValue)) {
        durVal = med.durationValue;
    } else if (med.durationValue) {
        const parsed = parseInt(String(med.durationValue).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    } else if (med.duration) {
        const parsed = parseInt(String(med.duration).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    }

    return {
        Medication: med.medication || med.Medication || med.name || med.Name,
        ConceptId: med.conceptId || med.ConceptId,
        Dosage: med.dosage || med.Dosage,
        DurationValue: durVal,
        DurationUnit: med.durationUnit || med.DurationUnit || (med.duration && isNaN(Number(med.duration)) ? med.duration : "Days"),
        FrequencyType: med.frequencyType || med.FrequencyType || med.frequency || med.Frequency,
        Instructions: med.instructions || med.Instructions || med.note || med.Note,
        Route: med.route || med.Route,
        CreatedBy: med.createdBy || med.CreatedBy,
        UpdatedBy: med.updatedBy || med.UpdatedBy,
        Schedules: med.schedules,
        Days: med.days
    };
};

const normalizeDiagnosis = (diag: any) => {
    if (!diag) return null;
    return {
        Diagnosis: typeof diag === "string" ? diag : diag.diagnosis || diag.Diagnosis,
        DiagnosisConceptId: diag.diagnosisConceptId || diag.DiagnosisConceptId
    };
};

const buildPrescriptionHeader = (source: any) => {
    const diagnoses = Array.isArray(source.diagnoses)
        ? source.diagnoses.map(normalizeDiagnosis).filter(Boolean)
        : source.diagnosis
            ? [normalizeDiagnosis(source)]
            : [];

    // Each medicine keeps its place on the prescription (1, 2, 3...), as the doctor wrote them.
    const medications = (Array.isArray(source.medications)
        ? source.medications.map(normalizeMedication).filter((med: any) => !!med.Medication)
        : [normalizeMedication(source)].filter((med: any) => !!med.Medication)
    ).map((med: any, index: number) => ({ ...med, SortOrder: index + 1 }));

    const docName = source.doctorName || source.doctor || "";
    const hospName = source.hospitalName || source.hospital || "";
    const externalLabel = docName ? (hospName ? `${docName} - ${hospName}` : docName) : "Doctor";

    return {
        PatientId: source.patientId || source.PatientId,
        DoctorId: source.doctorId || source.DoctorId || null,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy || externalLabel,
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        ...(normalizeLabTests(source) ? { LabTests: normalizeLabTests(source) } : {}),
        Notes: source.notes || source.Notes || source.prescriptionNotes || null,
        PdfUrl: source.pdfUrl || source.PdfUrl || null
    };
};

/**
 * Helper to generate prescription PDF and upload it directly to Azure Blob Storage.
 * Returns the public Azure Blob URL.
 */
/** The prescription's lab tests in the order they were added, with the hospital catalogue's code, sample and preparation. */
async function prescriptionLabTestsForPdf(prescriptionId: string) {
    const rows: any[] = await AppDataSource.query(
        `SELECT t.TestName, t.Category, t.Priority, t.Instructions, h.TestCode, h.SampleType, h.Preparation, h.Category AS CatalogCategory
         FROM PrescriptionLabTests t
         LEFT JOIN HospitalLabTests h ON h.Id = t.HospitalLabTestId
         WHERE t.PrescriptionId = @0
         ORDER BY t.Id`,
        [prescriptionId]
    );
    return rows.map((r) => ({
        name: r.TestName,
        code: r.TestCode,
        category: r.Category || r.CatalogCategory,
        sampleType: r.SampleType,
        preparation: r.Preparation,
        priority: r.Priority,
        instructions: r.Instructions,
    }));
}

/**
 * The medical record to print with a prescription: the one it was written from, else the latest
 * record of the same visit. Read with SELECT * so newer note columns are used when they exist.
 */
async function clinicalRecordForPdf(prescription: PatientPrescription) {
    const appointmentId = Number(prescription.AppointmentId) || 0;
    const recordId = prescription.MedicalRecordId ? String(prescription.MedicalRecordId) : null;
    if (!appointmentId && !recordId) return null;
    const [r]: any[] = await AppDataSource.query(
        `SELECT TOP 1 * FROM PatientMedicalRecord
         WHERE PatientId = @0 AND (CAST(Id AS NVARCHAR(64)) = @1 OR (@2 > 0 AND AppointmentId = @2))
           AND ISNULL(Status, '') <> 'Deleted'
         ORDER BY CASE WHEN CAST(Id AS NVARCHAR(64)) = @1 THEN 0 ELSE 1 END, COALESCE(UpdatedAt, CreatedAt) DESC`,
        [String(prescription.PatientId), recordId ?? "", appointmentId]
    ).catch((error: any) => {
        console.warn("[Prescription] Medical record for the PDF could not be read:", error?.message ?? error);
        return [];
    });
    if (!r) return null;
    return {
        allergies: r.Allergies,
        chiefComplaint: r.ChiefComplaint,
        symptoms: r.Symptoms,
        historyOfPresentIllness: r.HistoryOfPresentIllness,
        familyHistory: r.FamilyHistory,
        pastHistory: r.PastHistory,
        currentMedications: r.CurrentMedications,
        vitals: {
            temperature: r.Temperature,
            pulse: r.HeartRate,
            bloodPressure: r.BloodPressure,
            respiratoryRate: r.RespiratoryRate,
            spo2: r.SpO2,
            weight: r.Weight,
            height: r.Height,
        },
        generalExamination: r.PhysicalExamination,
        cvs: r.CvsExamination,
        rs: r.RespiratoryExamination,
        abdomen: r.AbdomenExamination,
        cns: r.CnsExamination,
        diagnosis: r.Diagnosis,
        diagnosisType: r.DiagnosisType,
        treatment: r.Treatment,
        followUpDate: r.FollowUpDate,
    };
}

export async function uploadPrescriptionPdfToBlob(prescriptionId: string, overrides?: any): Promise<string> {
    const prescriptionRepo = AppDataSource.getRepository(PatientPrescription);
    const prescription = await prescriptionRepo.findOne({
        where: { Id: String(prescriptionId) },
        relations: ["Diagnoses", "LabTests", "Medications", "Medications.Schedules", "Medications.Days", "Doctor"]
    });

    if (!prescription) {
        throw new Error(`Prescription with ID ${prescriptionId} not found`);
    }

    const patientId = prescription.PatientId;
    const doctorId = prescription.DoctorId;

    // 1. Fetch Doctor details
    let doctorName = overrides?.doctorName || overrides?.doctor || "";
    let doctorQual = overrides?.doctorQual || "";
    let doctorSpec = overrides?.specialty || overrides?.Specialty || "";
    let doctorReg = "";

    if (doctorId) {
        const userRepo = AppDataSource.getRepository(User);
        const docUser = await userRepo.findOne({ where: { Id: doctorId } });
        if (docUser && !doctorName) {
            doctorName = `${docUser.FirstName || ""} ${docUser.LastName || ""}`.trim();
        }
        // A doctor can work at several hospitals, each with its own record (registration, department):
        // use the one for this prescription's hospital.
        const hpRepo = AppDataSource.getRepository(HealthcareProvider);
        const rxHospitalId = Number(prescription.HospitalId) || 0;
        const hp = (rxHospitalId ? await hpRepo.findOne({ where: { UserId: doctorId, HospitalId: rxHospitalId, IsDeleted: false } as any }) : null)
            ?? await hpRepo.findOne({ where: { UserId: doctorId } });
        if (hp) {
            if (hp.Qualification && !doctorQual) doctorQual = hp.Qualification.trim();
            if ((hp.Specialty || hp.Department) && !doctorSpec) doctorSpec = (hp.Specialty || hp.Department).trim();
            if (hp.RegistrationNumber) doctorReg = hp.RegistrationNumber.trim();
        }
    }

    // 2. Fetch Hospital details
    let effectiveHospitalId = prescription.HospitalId || overrides?.hospitalId || overrides?.HospitalId;
    if (!effectiveHospitalId && doctorId) {
        const hpRepo = AppDataSource.getRepository(HealthcareProvider);
        const hp = await hpRepo.findOne({ where: { UserId: doctorId } });
        if (hp?.HospitalId) effectiveHospitalId = hp.HospitalId;
        if (!effectiveHospitalId) {
            const userRepo = AppDataSource.getRepository(User);
            const docUser = await userRepo.findOne({ where: { Id: doctorId } });
            if (docUser?.LatestHospitalId) effectiveHospitalId = docUser.LatestHospitalId;
        }
    }

    let hospitalName = overrides?.hospitalName || overrides?.hospital || "Yira Health Clinic";
    let hospitalAddress = overrides?.hospitalAddress || "";
    let hospitalCity = overrides?.hospitalCity || "";
    let hospitalState = overrides?.hospitalState || "";
    let hospitalPincode = "";
    let hospitalHelpline = "";
    let hospitalEmail = "";
    let hospitalWebsite = "";
    let hospitalLogo = "";

    if (effectiveHospitalId) {
        const hospRepo = AppDataSource.getRepository(Hospital);
        const hosp = await hospRepo.findOne({ where: { Id: Number(effectiveHospitalId) } });
        if (hosp) {
            if (hosp.Name) hospitalName = hosp.Name.trim();
            if (hosp.Address) hospitalAddress = hosp.Address.trim();
            if (hosp.City) hospitalCity = hosp.City.trim();
            if (hosp.State) hospitalState = hosp.State.trim();
            if (hosp.Pincode) hospitalPincode = hosp.Pincode.trim();
            if (hosp.HelplineNumber || hosp.MobileNumber) hospitalHelpline = (hosp.HelplineNumber || hosp.MobileNumber || "").trim();
            if (hosp.Email) hospitalEmail = hosp.Email.trim();
            if (hosp.Website) hospitalWebsite = hosp.Website.trim();
            if (hosp.ImageUrl) hospitalLogo = hosp.ImageUrl.trim();
        }
    }

    // 3. Fetch Patient details
    let patientName = overrides?.patientName || "";
    let patientGender = overrides?.gender || "";
    let patientPhone = overrides?.phone || "";
    let patientAge: string | number | undefined = undefined;
    let patientBlood = "";
    let patientIdentifier = "";
    let patientFolder = "patient";

    if (patientId) {
        const userRepo = AppDataSource.getRepository(User);
        const patUser = await userRepo.findOne({ where: { Id: patientId } });
        if (patUser) {
            patientName = `${patUser.FirstName || ""} ${patUser.LastName || ""}`.trim() || patientName;
            patientFolder = (patUser.FirstName || patUser.Email || patientId).toString().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
            if (patUser.Gender) patientGender = patUser.Gender.trim();
            if (patUser.PhoneNumber) patientPhone = patUser.PhoneNumber.trim();
            if (patUser.DateOfBirth) {
                const birthDate = new Date(patUser.DateOfBirth);
                const birthYear = birthDate.getFullYear();
                const currentYear = new Date().getFullYear();
                if (!isNaN(birthYear) && currentYear >= birthYear) {
                    patientAge = currentYear - birthYear;
                }
            }
            if (patUser.BloodGroup) patientBlood = patUser.BloodGroup.trim();
            if (patUser.TokenNumber) patientIdentifier = patUser.TokenNumber.trim();
        }

        if (!patientIdentifier) {
            try {
                const regRow = await AppDataSource.query(
                    "SELECT TOP 1 TokenNumber FROM PatientRegistrations WHERE UserId = @0 AND IsDeleted = 0 ORDER BY Id DESC",
                    [patientId]
                );
                if (regRow && regRow[0]?.TokenNumber) {
                    patientIdentifier = regRow[0].TokenNumber.trim();
                }
            } catch (_) {}
        }
    }

    // 4. Medications (in the order the doctor wrote them) & Diagnoses
    const medications = sortMedications(prescription.Medications || []).map((m: any) => {
        const overrideMed = Array.isArray(overrides?.medications)
            ? overrides.medications.find((om: any) => (om.medication || om.name || om.Medication) === (m.Medication || m.medication))
            : null;

        let dur = "";
        if (m.DurationValue) {
            dur = `${m.DurationValue} ${m.DurationUnit || 'Days'}`;
        } else if (overrideMed?.durationValue) {
            dur = `${overrideMed.durationValue} ${overrideMed.durationUnit || 'Days'}`;
        } else if (overrideMed?.duration) {
            dur = String(overrideMed.duration);
        } else if (m.duration) {
            dur = String(m.duration);
        } else if (m.DurationUnit && isNaN(Number(m.DurationUnit))) {
            dur = m.DurationUnit;
        }

        const instr = m.Instructions || m.instructions || overrideMed?.instructions || overrideMed?.note || overrideMed?.Instructions || m.note || "";

        return {
            name: m.Medication || m.medication || m.name || overrideMed?.medication || overrideMed?.name || "",
            dosage: m.Dosage || m.dosage || overrideMed?.dosage || "",
            frequency: m.FrequencyType || m.frequencyType || m.frequency || overrideMed?.frequency || overrideMed?.frequencyType || "",
            duration: dur,
            route: m.Route || m.route || overrideMed?.route || "",
            instructions: instr,
            note: instr
        };
    });

    const diagnoses = (prescription.Diagnoses || []).map((d: any) =>
        typeof d === "string" ? d : (d.Diagnosis || d.diagnosis || "")
    ).filter(Boolean);

    const clinicalRecord = await clinicalRecordForPdf(prescription);

    const pdfBuffer = await prescriptionPdfService.generatePrescriptionPdf({
        clinicalRecord,
        hospital: {
            name: hospitalName,
            address: hospitalAddress,
            city: hospitalCity,
            state: hospitalState,
            pincode: hospitalPincode,
            helpline: hospitalHelpline,
            email: hospitalEmail,
            website: hospitalWebsite,
            logoUrl: hospitalLogo
        },
        doctor: {
            name: doctorName,
            qualification: doctorQual,
            specialty: doctorSpec,
            registrationNumber: doctorReg
        },
        patient: {
            name: patientName,
            patientId: patientIdentifier || "NA",
            age: patientAge,
            gender: patientGender,
            phoneNumber: patientPhone,
            bloodGroup: patientBlood
        },
        prescription: {
            id: prescription.Id,
            prescriptionNumber: prescription.PrescriptionNumber,
            date: prescription.CreatedAt || new Date(),
            appointmentId: prescription.AppointmentId && String(prescription.AppointmentId).trim() !== "0" ? String(prescription.AppointmentId).trim() : undefined,
            diagnoses,
            medications,
            labTests: await prescriptionLabTestsForPdf(String(prescription.Id)),
            notes: prescription.Notes || overrides?.notes || overrides?.Notes || undefined
        }
    });

    // 5. Upload to Azure Blob Storage
    const blobPath = `${patientFolder}/prescriptions/Prescription_${prescription.Id}.pdf`;
    const blobUrl = await blobService.uploadBuffer(pdfBuffer, blobPath, "application/pdf");
    console.log(`[Prescription] Uploaded PDF to Azure Blob: ${blobUrl}`);

    // 6. Update database with Azure Blob URL
    // Times are written as India time by the app (Azure SQL's GETDATE() is UTC).
    await AppDataSource.query("UPDATE PatientPrescription SET PdfUrl = @0, UpdatedAt = @2 WHERE Id = @1", [blobUrl, prescription.Id, new Date()]);

    // 7. Update or Insert into MedicalDocuments archive
    try {
        // Only this appointment's generated prescription PDF (Prescription_<id>.pdf, whatever its category)
        // may be replaced, never the diet plan PDFs, reports or other files filed under the same appointment.
        const existingDocs = await AppDataSource.query(
            "SELECT TOP 1 Id FROM MedicalDocuments WHERE (FileName LIKE @0 OR (AppointmentId = @1 AND FileName LIKE 'Prescription[_]%')) AND PatientId = @2",
            [`%${prescription.Id}%`, Number(prescription.AppointmentId) || -1, String(patientId)]
        );

        if (existingDocs && existingDocs.length > 0) {
            await AppDataSource.query(
                "UPDATE MedicalDocuments SET BlobUrl = @0, FileSize = @1, UpdatedAt = @3 WHERE Id = @2",
                [blobUrl, pdfBuffer.length, existingDocs[0].Id, new Date()]
            );
        } else {
            const medDoc = new MedicalDocument();
            medDoc.PatientId = String(patientId);
            medDoc.AppointmentId = prescription.AppointmentId ? Number(prescription.AppointmentId) || undefined : undefined;
            medDoc.DoctorId = doctorId ? String(doctorId) : undefined;
            medDoc.OrganizationId = Number(prescription.OrganizationId) || 1;
            medDoc.HospitalId = Number(prescription.HospitalId) || 19;
            medDoc.DocumentType = "Prescription";
            medDoc.DocumentCategory = "Prescription";
            medDoc.FileName = `Prescription_${prescription.Id}.pdf`;
            medDoc.OriginalFileName = `Prescription_${new Date().toISOString().split("T")[0]}.pdf`;
            medDoc.BlobUrl = blobUrl;
            medDoc.FileSize = pdfBuffer.length;
            medDoc.MimeType = "application/pdf";
            medDoc.FileExtension = ".pdf";
            medDoc.CreatedAt = new Date();
            await medicalDocumentRepository.save(medDoc);
        }
    } catch (docErr) {
        console.warn("[Prescription] MedicalDocument archive notice:", docErr);
    }

    return blobUrl;
}

export class MobilePrescriptionController {
    async getPatientPrescriptions(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const { orgId, hospitalId, appointmentId } = req.query;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const prescriptions = await patientPrescriptionService.getPatientPrescriptions(
                patientId,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? String(appointmentId) : undefined
            );

            return res.json(ApiResponse.success(prescriptions, "Prescriptions fetched successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async addPrescription(req: Request, res: Response) {
        try {
            const body = req.body;
            const results: any[] = [];

            const incomingId = body.id || body.Id || (Array.isArray(body) && (body[0]?.id || body[0]?.Id));
            const patientId = body.patientId || body.PatientId || (Array.isArray(body) && (body[0]?.patientId || body[0]?.PatientId));
            const appointmentId = body.appointmentId || body.AppointmentId || (Array.isArray(body) && (body[0]?.appointmentId || body[0]?.AppointmentId));

            // Check if this is an update to an existing prescription (by ID or AppointmentId)
            let existingPrescriptionId = incomingId;
            if (!existingPrescriptionId && appointmentId && String(appointmentId).trim() !== "0") {
                const existing = await AppDataSource.query(
                    "SELECT TOP 1 Id, PdfUrl FROM PatientPrescription WHERE AppointmentId = @0 ORDER BY CreatedAt DESC",
                    [String(appointmentId)]
                );
                if (existing && existing[0]?.Id) {
                    existingPrescriptionId = existing[0].Id;
                }
            }

            // If updating an existing prescription: update details and upload new PDF to Azure Blob
            if (existingPrescriptionId) {
                const header = buildPrescriptionHeader(body);
                await patientPrescriptionService.updatePrescription(String(existingPrescriptionId), header);

                const isManualPrescription = Boolean(
                    body.isManual === true ||
                    body.isPatientManual === true ||
                    body.type === "manual" ||
                    (!body.doctorId && !body.DoctorId && !header.DoctorId)
                );
                let pdfUrl: string = body.pdfUrl || body.PdfUrl || "";
                if (!isManualPrescription && (!pdfUrl || !pdfUrl.startsWith("http") || pdfUrl.includes("localhost") || pdfUrl.includes("192.168."))) {
                    try {
                        pdfUrl = await uploadPrescriptionPdfToBlob(String(existingPrescriptionId), body);
                    } catch (uploadErr) {
                        console.error("[PrescriptionController] Failed to upload updated PDF to Azure Blob:", uploadErr);
                    }
                }

                const updatedRecord = await patientPrescriptionService.getPrescriptionById(String(existingPrescriptionId));
                if (updatedRecord && pdfUrl) {
                    updatedRecord.PdfUrl = pdfUrl;
                    (updatedRecord as any).pdfUrl = pdfUrl;
                }

                try {
                    if (patientId) {
                        await pushNotificationService.notifyPrescriptionAdded({
                            patientId,
                            doctorId: header.DoctorId || body.doctorId,
                            appointmentId,
                            prescriptionId: existingPrescriptionId
                        });
                    }
                } catch (_) {}

                return res.status(200).json(ApiResponse.success(updatedRecord ? [updatedRecord] : [{ Id: existingPrescriptionId, PdfUrl: pdfUrl }], "Prescription updated successfully"));
            }

            // Creating new prescription
            if (Array.isArray(body) && !body[0]?.medications) {
                for (const item of body) {
                    const prescription = buildPrescriptionHeader(item);
                    results.push(await patientPrescriptionService.addPrescription(prescription));
                }
            } else {
                const header = buildPrescriptionHeader(body);
                if (!header.PatientId) {
                    return res.status(400).json(ApiResponse.error("Patient ID is required"));
                }
                results.push(await patientPrescriptionService.addPrescription(header));
            }

            const firstResult = results[0];
            const doctorId = firstResult?.DoctorId || body.doctorId || body.DoctorId;

            // ── Automated Digital Prescription PDF Generation & Upload to Azure Blob ──
            const isManualPrescription = Boolean(
                body.isManual === true ||
                body.isPatientManual === true ||
                body.type === "manual" ||
                (!doctorId && !body.doctorId && !body.DoctorId)
            );
            let pdfUrl: string = body.pdfUrl || body.PdfUrl || "";
            try {
                if (firstResult?.Id) {
                    if (!isManualPrescription && (!pdfUrl || !pdfUrl.startsWith("http") || pdfUrl.includes("localhost") || pdfUrl.includes("192.168."))) {
                        pdfUrl = await uploadPrescriptionPdfToBlob(String(firstResult.Id), body);
                    }
                    firstResult.PdfUrl = pdfUrl || null;
                    firstResult.pdfUrl = pdfUrl || null;
                }

                // Trigger Push Notification to Patient
                try {
                    if (patientId) {
                        await pushNotificationService.notifyPrescriptionAdded({
                            patientId,
                            doctorId,
                            doctorName: body.doctorName || body.doctor,
                            appointmentId,
                            prescriptionId: firstResult?.Id
                        });
                    }
                } catch (e) {
                    console.error("Failed to send prescription push notification:", e);
                }
            } catch (pdfGenErr) {
                console.error("[PrescriptionController] Prescription PDF generation & Azure Blob upload error:", pdfGenErr);
            }

            return res.status(201).json(ApiResponse.success(results, "Prescription saved successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Add Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPrescriptionPdf(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Prescription ID is required"));
            }

            const prescriptionRepo = AppDataSource.getRepository(PatientPrescription);
            const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(id));
            let prescription = null;
            if (isUuid) {
                prescription = await prescriptionRepo.findOne({
                    where: { Id: String(id) }
                });
            } else {
                // Support looking up by AppointmentId or PrescriptionNumber
                prescription = await prescriptionRepo.findOne({
                    where: [
                        { AppointmentId: String(id) },
                        ...(isNaN(Number(id)) ? [] : [{ PrescriptionNumber: Number(id) }])
                    ],
                    order: { CreatedAt: "DESC" }
                });
            }

            if (!prescription) {
                return res.status(404).json(ApiResponse.error("Prescription not found"));
            }

            // If Azure Blob URL already exists, redirect directly to Azure Blob
            if (prescription.PdfUrl && prescription.PdfUrl.startsWith("http") && !prescription.PdfUrl.includes("localhost") && !prescription.PdfUrl.includes("192.168.")) {
                return res.redirect(prescription.PdfUrl);
            }

            // Otherwise, generate and upload to Azure Blob Storage now
            const blobUrl = await uploadPrescriptionPdfToBlob(String(prescription.Id));
            return res.redirect(blobUrl);
        } catch (error: any) {
            console.error("Prescription PDF fetch error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updatePrescription(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const body = req.body;

            if (!id) {
                return res.status(400).json(ApiResponse.error("Prescription ID is required"));
            }

            const prescription = buildPrescriptionHeader(body);
            await patientPrescriptionService.updatePrescription(String(id), prescription);

            // Generate and upload updated PDF directly to Azure Blob Storage
            let pdfUrl: string = body.pdfUrl || body.PdfUrl || "";
            if (!pdfUrl || !pdfUrl.startsWith("http") || pdfUrl.includes("localhost") || pdfUrl.includes("192.168.")) {
                try {
                    pdfUrl = await uploadPrescriptionPdfToBlob(String(id), body);
                } catch (uploadErr) {
                    console.error("[PrescriptionController] Failed to upload updated PDF to Azure Blob:", uploadErr);
                }
            }

            return res.json(ApiResponse.success({ id, pdfUrl }, "Prescription updated successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Update Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deletePrescription(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Prescription ID is required"));
            }

            // Only the record's author, or the patient for records they added themselves.
            const { AppDataSource } = await import("../../../../config/database.js");
            const { PatientPrescription } = await import("../../../../models/Appointments/patient-prescription.model.js");
            const { canDeleteRecord, requesterIdOf } = await import("../../../../middlewares/record-ownership.js");
            const existing = await AppDataSource.getRepository(PatientPrescription).findOne({ where: { Id: String(id) } as any });
            if (!existing) {
                return res.status(404).json(ApiResponse.error("Prescription not found"));
            }
            if (!(await canDeleteRecord(requesterIdOf(req), existing as any))) {
                return res.status(403).json(ApiResponse.error("You can only delete prescriptions you added."));
            }

            await patientPrescriptionService.deletePrescription(String(id));
            return res.json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobilePrescriptionController = new MobilePrescriptionController();

