import { Request, Response } from "express";
import { patientPrescriptionService } from "../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { AppDataSource } from "../../config/database.js";
import { renderPrescriptionPdf, uploadPrescriptionPdfToBlob } from "../../MobileApi/v1/controllers/provider/prescription.controller.js";
import { normalizeLabTests } from "../../utils/prescription-lab-tests.utils.js";
import { editLockMessage } from "../../utils/edit-window.js";

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

    return {
        PatientId: source.patientId || source.PatientId,
        DoctorId: source.doctorId || source.DoctorId || null,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy,
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        ...(normalizeLabTests(source) ? { LabTests: normalizeLabTests(source) } : {}),
        Notes: source.notes || source.Notes || source.prescriptionNotes || null,
        PdfUrl: source.pdfUrl || source.PdfUrl || null
    };
};

export class PatientPrescriptionController {
    async addPrescription(req: Request, res: Response): Promise<void> {
        try {
            const body = req.body;
            const results: any[] = [];

            if (Array.isArray(body) && !body[0]?.medications) {
                for (const item of body) {
                    const prescription = buildPrescriptionHeader(item);
                    const saved = await patientPrescriptionService.addPrescription(prescription);
                    const isManual = Boolean(item.isManual || item.isPatientManual || item.type === "manual" || (!item.doctorId && !item.DoctorId));
                    if (saved?.Id && !isManual) {
                        try {
                            const blobUrl = await uploadPrescriptionPdfToBlob(String(saved.Id), item);
                            saved.PdfUrl = blobUrl;
                            (saved as any).pdfUrl = blobUrl;
                        } catch (blobErr) {
                            console.error("[PatientPrescriptionController] Azure Blob upload error:", blobErr);
                        }
                    }
                    results.push(saved);
                }
            } else {
                const header = buildPrescriptionHeader(body);
                const saved = await patientPrescriptionService.addPrescription(header);
                const isManual = Boolean(body.isManual || body.isPatientManual || body.type === "manual" || (!body.doctorId && !body.DoctorId));
                if (saved?.Id && !isManual) {
                    try {
                        const blobUrl = await uploadPrescriptionPdfToBlob(String(saved.Id), body);
                        saved.PdfUrl = blobUrl;
                        (saved as any).pdfUrl = blobUrl;
                    } catch (blobErr) {
                        console.error("[PatientPrescriptionController] Azure Blob upload error:", blobErr);
                    }
                }
                results.push(saved);
            }

            res.status(201).json(ApiResponse.success(results, "Prescription added successfully"));
        } catch (error: any) {
            console.error("Error in addPrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPatientPrescriptions(req: Request, res: Response): Promise<void> {
        try {
            const { patientId } = req.params;
            const { orgId, hospitalId, appointmentId } = req.query;

            const prescriptions = await patientPrescriptionService.getPatientPrescriptions(
                patientId as string,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined,
                appointmentId ? String(appointmentId) : undefined
            );

            res.status(200).json(ApiResponse.success(prescriptions));
        } catch (error: any) {
            console.error("Error in getPatientPrescriptions:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async getPrescriptionsByAppointment(req: Request, res: Response): Promise<void> {
        try {
            const { appointmentId } = req.params;
            const { orgId, hospitalId } = req.query;

            const prescriptions = await patientPrescriptionService.getPrescriptionsByAppointment(
                appointmentId as string,
                orgId ? parseInt(String(orgId)) : undefined,
                hospitalId ? parseInt(String(hospitalId)) : undefined
            );

            res.status(200).json(ApiResponse.success(prescriptions));
        } catch (error: any) {
            console.error("Error in getPrescriptionsByAppointment:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updatePrescription(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id as string;
            const body = req.body;
            console.info("updatePrescription called", { id, body });
            const locked = await editLockMessage("prescription", id);
            if (locked) { res.status(403).json(ApiResponse.error(locked)); return; }
            const prescription: any = buildPrescriptionHeader(body);
            // An edit that doesn't send the visit or the doctor (e.g. from the Patients page) keeps the
            // saved ones: writing null cleared the link, and the PDF then printed "Appt ID: #NA".
            if (body.appointmentId === undefined && body.AppointmentId === undefined) delete prescription.AppointmentId;
            if (body.doctorId === undefined && body.DoctorId === undefined) delete prescription.DoctorId;

            await patientPrescriptionService.updatePrescription(id, prescription);

            // Generate and upload updated PDF directly to Azure Blob Storage
            let pdfUrl: string = body.pdfUrl || body.PdfUrl || "";
            if (!pdfUrl || !pdfUrl.startsWith("http") || pdfUrl.includes("localhost") || pdfUrl.includes("192.168.")) {
                try {
                    pdfUrl = await uploadPrescriptionPdfToBlob(id, body);
                } catch (uploadErr) {
                    console.error("[PatientPrescriptionController] Failed to upload updated PDF to Azure Blob:", uploadErr);
                }
            }

            res.status(200).json(ApiResponse.success({ id, pdfUrl }, "Prescription updated successfully"));
        } catch (error: any) {
            console.error("Error in updatePrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }

    /**
     * The PDF a prescription would get, drawn from the unsaved draft (the same body the page saves),
     * so the doctor can check it and go back to edit before saving. Nothing is stored.
     */
    async previewPrescription(req: Request, res: Response): Promise<void> {
        try {
            const body = req.body ?? {};
            if (!body.patientId && !body.PatientId) {
                res.status(400).json(ApiResponse.error("Patient is required."));
                return;
            }
            const header: any = buildPrescriptionHeader(body);
            const draft = { ...header, Id: undefined, PrescriptionNumber: null, CreatedAt: new Date() };

            // The draft's investigations, with the hospital catalogue's code, sample and preparation as a saved one gets.
            const tests: any[] = header.LabTests || [];
            const catalogIds = tests.map((t) => Number(t.HospitalLabTestId)).filter((id) => id > 0);
            const catalog: any[] = catalogIds.length
                ? await AppDataSource.query(
                    `SELECT Id, TestCode, SampleType, Preparation, Category FROM HospitalLabTests WHERE Id IN (${catalogIds.map((_, i) => `@${i}`).join(",")})`,
                    catalogIds
                )
                : [];
            const labTests = tests.map((t) => {
                const c = catalog.find((row) => Number(row.Id) === Number(t.HospitalLabTestId));
                return {
                    name: t.TestName,
                    code: c?.TestCode ?? null,
                    category: t.Category || c?.Category || null,
                    sampleType: c?.SampleType ?? null,
                    preparation: c?.Preparation ?? null,
                    priority: t.Priority || undefined,
                    instructions: t.Instructions,
                };
            });

            const { pdfBuffer } = await renderPrescriptionPdf(draft, body, labTests);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", 'inline; filename="Prescription_preview.pdf"');
            res.setHeader("Cache-Control", "no-store");
            res.send(pdfBuffer);
        } catch (error: any) {
            console.error("Error in previewPrescription:", error);
            res.status(500).json(ApiResponse.error(error.message || "Couldn't draw the preview."));
        }
    }

    async deletePrescription(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id as string;
            await patientPrescriptionService.deletePrescription(id);
            res.status(200).json(ApiResponse.success(null, "Prescription deleted successfully"));
        } catch (error: any) {
            console.error("Error in deletePrescription:", error);
            res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const patientPrescriptionController = new PatientPrescriptionController();
