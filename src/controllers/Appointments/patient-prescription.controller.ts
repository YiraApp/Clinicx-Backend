import { Request, Response } from "express";
import { patientPrescriptionService } from "../../services/Appointments/patient-prescription.service.js";
import { ApiResponse } from "../../utils/response.utils.js";
import { AppDataSource } from "../../config/database.js";
import { uploadPrescriptionPdfToBlob } from "../../MobileApi/v1/controllers/provider/prescription.controller.js";
import { buildPrescriptionHeader } from "../../services/Appointments/prescription-mapping.js";


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
            const prescription = buildPrescriptionHeader(body);

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
