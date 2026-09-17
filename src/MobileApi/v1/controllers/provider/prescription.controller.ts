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

const normalizeMedication = (med: any) => ({
    Medication: med.medication || med.Medication,
    ConceptId: med.conceptId || med.ConceptId,
    Dosage: med.dosage || med.Dosage,
    DurationValue: typeof med.durationValue === "number" ? med.durationValue : (med.durationValue ? parseInt(med.durationValue) : undefined),
    DurationUnit: med.durationUnit || med.Duration || med.duration || "Days",
    FrequencyType: med.frequencyType || med.FrequencyType || med.frequency || med.Frequency,
    Instructions: med.instructions || med.Instructions,
    Route: med.route || med.Route,
    CreatedBy: med.createdBy || med.CreatedBy,
    UpdatedBy: med.updatedBy || med.UpdatedBy,
    Schedules: med.schedules,
    Days: med.days
});

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

    const medications = Array.isArray(source.medications)
        ? source.medications.map(normalizeMedication).filter((med: any) => !!med.Medication)
        : [normalizeMedication(source)].filter((med: any) => !!med.Medication);

    return {
        PatientId: source.patientId || source.PatientId,
        DoctorId: source.doctorId || source.DoctorId,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy || "Doctor",
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        Notes: source.notes || source.Notes || source.prescriptionNotes || null
    };
};

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
            let headerPayload: any = null;

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

            // If updating an existing prescription: DO NOT re-upload, just update details and URL
            if (existingPrescriptionId) {
                const header = buildPrescriptionHeader(body);
                headerPayload = header;
                await patientPrescriptionService.updatePrescription(String(existingPrescriptionId), header);

                const host = req.get("host") || "192.168.68.94:5000";
                const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
                const pdfUrl = `${protocol}://${host}/v1/api/auth/prescriptions/${existingPrescriptionId}/pdf`;

                await AppDataSource.query("UPDATE PatientPrescription SET PdfUrl = @0, UpdatedAt = GETDATE() WHERE Id = @1", [pdfUrl, existingPrescriptionId]);

                try {
                    await AppDataSource.query(
                        "UPDATE MedicalDocuments SET BlobUrl = @0, UpdatedAt = GETDATE() WHERE (FileName LIKE @1 OR AppointmentId = @2) AND PatientId = @3",
                        [pdfUrl, `%${existingPrescriptionId}%`, Number(appointmentId) || -1, String(patientId)]
                    );
                } catch (_) {}

                const updatedRecord = await patientPrescriptionService.getPrescriptionById(String(existingPrescriptionId));
                if (updatedRecord) {
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

            if (Array.isArray(body) && !body[0]?.medications) {
                for (const item of body) {
                    const prescription = buildPrescriptionHeader(item);
                    headerPayload = prescription;
                    results.push(await patientPrescriptionService.addPrescription(prescription));
                }
            } else {
                const header = buildPrescriptionHeader(body);
                headerPayload = header;
                if (!header.PatientId) {
                    return res.status(400).json(ApiResponse.error("Patient ID is required"));
                }
                results.push(await patientPrescriptionService.addPrescription(header));
            }

            const firstResult = results[0];
            const doctorId = firstResult?.DoctorId || body.doctorId || body.DoctorId;
            const hospitalId = firstResult?.HospitalId || body.hospitalId || body.HospitalId;

            // ── Automated Digital Prescription PDF Generation ──
            try {
                // 1. Fetch Doctor details strictly from database
                let doctorName = "";
                let doctorQual = "";
                let doctorSpec = "";
                let doctorReg = "";

                if (doctorId) {
                    const userRepo = AppDataSource.getRepository(User);
                    const docUser = await userRepo.findOne({ where: { Id: doctorId } });
                    if (docUser) {
                        doctorName = `${docUser.FirstName || ""} ${docUser.LastName || ""}`.trim();
                    }
                    const hpRepo = AppDataSource.getRepository(HealthcareProvider);
                    const hp = await hpRepo.findOne({ where: { UserId: doctorId } });
                    if (hp) {
                        if (hp.Qualification) doctorQual = hp.Qualification.trim();
                        if (hp.Specialty || hp.Department) doctorSpec = (hp.Specialty || hp.Department).trim();
                        if (hp.RegistrationNumber) doctorReg = hp.RegistrationNumber.trim();
                    }
                }

                // 2. Fetch Hospital details strictly from database
                let effectiveHospitalId = hospitalId || firstResult?.HospitalId || body.HospitalId || body.hospitalId;
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

                let hospitalName = "";
                let hospitalAddress = "";
                let hospitalCity = "";
                let hospitalState = "";
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

                // 3. Fetch Patient details strictly from database
                let patientName = body.patientName || "";
                let patientGender = body.gender || "";
                let patientPhone = body.phone || "";
                let patientAge: string | number | undefined = undefined;
                let patientBlood = "";
                let patientIdentifier = "";

                if (patientId) {
                    const userRepo = AppDataSource.getRepository(User);
                    const patUser = await userRepo.findOne({ where: { Id: patientId } });
                    if (patUser) {
                        patientName = `${patUser.FirstName || ""} ${patUser.LastName || ""}`.trim() || patientName;
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

                // 4. Extract medications and diagnoses from DB payload
                const medications = (firstResult?.Medications || headerPayload?.Medications || []).map((m: any) => ({
                    name: m.Medication || m.medication || m.name || "",
                    dosage: m.Dosage || m.dosage || "",
                    frequency: m.FrequencyType || m.frequencyType || m.frequency || "",
                    duration: m.DurationValue ? `${m.DurationValue} ${m.DurationUnit || 'Days'}` : (m.duration || ""),
                    route: m.Route || m.route || "",
                    instructions: m.Instructions || m.instructions || ""
                }));

                const diagnoses = (firstResult?.Diagnoses || headerPayload?.Diagnoses || []).map((d: any) =>
                    typeof d === "string" ? d : (d.Diagnosis || d.diagnosis || "")
                ).filter(Boolean);

                const prescriptionId = String(firstResult?.Id || body.id || "");
                const prescriptionDate = firstResult?.CreatedAt || firstResult?.Date || new Date();
                const presNotes = firstResult?.Notes || headerPayload?.Notes || body.notes || body.Notes || "";

                let prescriptionNumber = firstResult?.PrescriptionNumber;
                if (!prescriptionNumber && prescriptionId) {
                    try {
                        const row = await AppDataSource.query("SELECT PrescriptionNumber FROM PatientPrescription WHERE Id = @0", [prescriptionId]);
                        if (row && row[0]?.PrescriptionNumber) {
                            prescriptionNumber = row[0].PrescriptionNumber;
                        }
                    } catch (_) {}
                }

                const pdfBuffer = await prescriptionPdfService.generatePrescriptionPdf({
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
                        id: prescriptionId,
                        prescriptionNumber: prescriptionNumber,
                        date: prescriptionDate,
                        appointmentId: appointmentId && String(appointmentId).trim() !== "0" ? String(appointmentId).trim() : undefined,
                        diagnoses,
                        medications,
                        notes: presNotes
                    }
                });

                // 5. Dynamic PDF URL (Direct streaming, no static blob upload required)
                const host = req.get("host") || "192.168.68.94:5000";
                const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
                const pdfUrl = `${protocol}://${host}/v1/api/auth/prescriptions/${firstResult?.Id || prescriptionId}/pdf`;

                // 6. Update PatientPrescription record with PdfUrl
                if (firstResult?.Id && pdfUrl) {
                    await AppDataSource.query("UPDATE PatientPrescription SET PdfUrl = @0 WHERE Id = @1", [pdfUrl, firstResult.Id]);
                    firstResult.PdfUrl = pdfUrl;
                    firstResult.pdfUrl = pdfUrl;
                }

                // 7. Save into MedicalDocuments archive with the dynamic PDF URL
                try {
                    const medDoc = new MedicalDocument();
                    medDoc.PatientId = String(patientId);
                    medDoc.AppointmentId = firstResult?.AppointmentId ? Number(firstResult.AppointmentId) || undefined : undefined;
                    medDoc.DoctorId = doctorId ? String(doctorId) : undefined;
                    medDoc.OrganizationId = Number(firstResult?.OrganizationId) || 1;
                    medDoc.HospitalId = Number(firstResult?.HospitalId) || 19;
                    medDoc.DocumentType = "Prescription";
                    medDoc.DocumentCategory = "Prescription";
                    medDoc.FileName = `Prescription_${firstResult?.Id || prescriptionId}.pdf`;
                    medDoc.OriginalFileName = `Prescription_${new Date().toISOString().split("T")[0]}.pdf`;
                    medDoc.BlobUrl = pdfUrl;
                    medDoc.FileSize = pdfBuffer.length;
                    medDoc.MimeType = "application/pdf";
                    medDoc.FileExtension = ".pdf";
                    await medicalDocumentRepository.save(medDoc);
                } catch (docErr) {
                    console.warn("[PrescriptionController] MedicalDocument archive warning:", docErr);
                }

                // Trigger Push Notification to Patient
                try {
                    if (patientId) {
                        await pushNotificationService.notifyPrescriptionAdded({
                            patientId,
                            doctorId,
                            doctorName,
                            appointmentId,
                            prescriptionId: firstResult?.Id
                        });
                    }
                } catch (e) {
                    console.error("Failed to send prescription push notification:", e);
                }
            } catch (pdfGenErr) {
                console.error("[PrescriptionController] Prescription PDF generation error:", pdfGenErr);
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
            const prescription = await prescriptionRepo.findOne({
                where: { Id: String(id) },
                relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days", "Doctor"]
            });

            if (!prescription) {
                return res.status(404).json(ApiResponse.error("Prescription not found"));
            }

            // Gather metadata strictly from database
            let doctorName = prescription.Doctor ? `${prescription.Doctor.FirstName || ""} ${prescription.Doctor.LastName || ""}`.trim() : "";
            let doctorQual = "";
            let doctorSpec = "";
            let doctorReg = "";

            if (prescription.DoctorId) {
                if (!doctorName) {
                    const userRepo = AppDataSource.getRepository(User);
                    const docUser = await userRepo.findOne({ where: { Id: prescription.DoctorId } });
                    if (docUser) {
                        doctorName = `${docUser.FirstName || ""} ${docUser.LastName || ""}`.trim();
                    }
                }
                const hpRepo = AppDataSource.getRepository(HealthcareProvider);
                const hp = await hpRepo.findOne({ where: { UserId: prescription.DoctorId } });
                if (hp) {
                    if (hp.Qualification) doctorQual = hp.Qualification.trim();
                    if (hp.Specialty || hp.Department) doctorSpec = (hp.Specialty || hp.Department).trim();
                    if (hp.RegistrationNumber) doctorReg = hp.RegistrationNumber.trim();
                }
            }

            let effectiveHospitalId = prescription.HospitalId;
            if (!effectiveHospitalId && prescription.DoctorId) {
                const hpRepo = AppDataSource.getRepository(HealthcareProvider);
                const hp = await hpRepo.findOne({ where: { UserId: prescription.DoctorId } });
                if (hp?.HospitalId) effectiveHospitalId = hp.HospitalId;
            }

            let hospitalName = "";
            let hospitalAddress = "";
            let hospitalCity = "";
            let hospitalState = "";
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

            let patientName = "";
            let patientGender = "";
            let patientPhone = "";
            let patientAge: string | number | undefined = undefined;
            let patientBlood = "";
            let patientIdentifier = "";

            if (prescription.PatientId) {
                const userRepo = AppDataSource.getRepository(User);
                const patUser = await userRepo.findOne({ where: { Id: prescription.PatientId } });
                if (patUser) {
                    patientName = `${patUser.FirstName || ""} ${patUser.LastName || ""}`.trim();
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
                            [prescription.PatientId]
                        );
                        if (regRow && regRow[0]?.TokenNumber) {
                            patientIdentifier = regRow[0].TokenNumber.trim();
                        }
                    } catch (_) {}
                }
            }

            const medications = (prescription.Medications || []).map((m: any) => ({
                name: m.Medication || m.medication || m.name || "",
                dosage: m.Dosage || m.dosage || "",
                frequency: m.FrequencyType || m.frequencyType || m.frequency || "",
                duration: m.DurationValue ? `${m.DurationValue} ${m.DurationUnit || 'Days'}` : (m.duration || ""),
                route: m.Route || m.route || "",
                instructions: m.Instructions || m.instructions || ""
            }));

            const diagnoses = (prescription.Diagnoses || []).map((d: any) =>
                typeof d === "string" ? d : (d.Diagnosis || d.diagnosis || "")
            ).filter(Boolean);

            const pdfBuffer = await prescriptionPdfService.generatePrescriptionPdf({
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
                    date: prescription.CreatedAt || prescription.Date || new Date(),
                    appointmentId: prescription.AppointmentId && String(prescription.AppointmentId).trim() !== "0" ? String(prescription.AppointmentId).trim() : undefined,
                    diagnoses,
                    medications,
                    notes: prescription.Notes || undefined
                }
            });

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="Prescription_${id}.pdf"`);
            return res.send(pdfBuffer);
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

            const host = req.get("host") || "192.168.68.94:5000";
            const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
            const pdfUrl = `${protocol}://${host}/v1/api/auth/prescriptions/${id}/pdf`;
            (prescription as any).PdfUrl = pdfUrl;

            await patientPrescriptionService.updatePrescription(String(id), prescription);

            // Update PdfUrl in database without re-uploading
            await AppDataSource.query("UPDATE PatientPrescription SET PdfUrl = @0, UpdatedAt = GETDATE() WHERE Id = @1", [pdfUrl, id]);

            // Update MedicalDocuments archive if existing
            try {
                await AppDataSource.query(
                    "UPDATE MedicalDocuments SET BlobUrl = @0, UpdatedAt = GETDATE() WHERE FileName LIKE @1 OR AppointmentId = @2",
                    [pdfUrl, `%${id}%`, prescription.AppointmentId ? Number(prescription.AppointmentId) : -1]
                );
            } catch (_) {}

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

            await patientPrescriptionService.deletePrescription(String(id));
            return res.json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Prescription Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobilePrescriptionController = new MobilePrescriptionController();

