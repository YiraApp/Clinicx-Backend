import { Request, Response } from "express";
import { medicalDocumentService } from "../../../../services/Appointments/medical-document.service.js";
import { medicalReportAiService, ReportAnalysisError } from "../../../../services/Appointments/medical-report-ai.service.js";
import { ANALYSIS_PENDING_MESSAGE, medSenseService } from "../../../../services/Appointments/medsense.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";
import { isFamilyLinked } from "../../../../middlewares/request-identity.js";
import { canOpenDocument } from "../../../../utils/document-access.js";
import { requireTokenActor } from "../../../../utils/request-actor.js";
import { workingAccountId } from "../../../../utils/work-access.js";

export class MobileMedicalDocumentController {
    async getPatientDocuments(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const appointmentId = req.query.appointmentId ? Number(req.query.appointmentId) : undefined;
            const limit = req.query.limit ? Number(req.query.limit) : undefined;
            // "Load more" asks for page 2, 3...; without this every page was the first one again.
            const page = req.query.page ? Math.max(1, Math.floor(Number(req.query.page)) || 1) : 1;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            // Set by requirePatientRecordAccess: a doctor without the patient's consent sees only his own documents.
            const doctorId: string | undefined = res.locals.recordDoctorId;
            let result = await medicalDocumentService.getPatientDocuments(patientId, organizationId, hospitalId, appointmentId, limit, page, doctorId);

            // In a hospital's view, staff see what was added there, not the
            // patient's own uploads that are not tied to a visit. The patient, or a
            // family member acting for them, always sees their own uploads.
            const requesterId = String((req as any).user?.userId || (req as any).user?.id || "");
            if (hospitalId && !appointmentId && !(await isFamilyLinked(requesterId, String(patientId)))) {
                result = result.filter((d: any) => !(d.IsPatientUploaded && !d.AppointmentId));
            }
            return res.json(ApiResponse.success(result, "Patient documents fetched successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async uploadDocuments(req: Request, res: Response) {
        try {
            const files = req.files as Express.Multer.File[];
            if (!files || files.length === 0) {
                return res.status(400).json(ApiResponse.error("No document files uploaded."));
            }

            const payload = {
                ...req.query,
                ...req.body,
                uploadedByUserId: (req as any).user?.id || req.body?.uploadedByUserId || req.query?.uploadedByUserId,
            };

            const result = await medicalDocumentService.uploadDocuments(payload, files);
            return res.status(201).json(ApiResponse.success(result, "Documents uploaded successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Upload Error:", error);
            return res.status(500).json(ApiResponse.error("The document could not be saved. Please try again."));
        }
    }

    /**
     * Uploads one report (a PDF of up to 10 pages, or 1-10 page photos joined
     * into one PDF) and, when analyze=true, reads it with AI straight away.
     */
    async uploadReport(req: Request, res: Response) {
        try {
            const files = (req.files as Express.Multer.File[]) || [];
            const requesterId = this.requesterId(req);
            const prepared = await medicalReportAiService.prepareReport(files, req.body?.title);

            const reportFile = {
                fieldname: "files",
                originalname: prepared.fileName,
                mimetype: prepared.mimeType,
                buffer: prepared.buffer,
                size: prepared.buffer.length,
            } as Express.Multer.File;

            const payload = {
                ...req.query,
                ...req.body,
                uploadedByUserId: requesterId || req.body?.uploadedByUserId,
            };
            const [document] = await medicalDocumentService.uploadDocuments(payload, [reportFile]);

            let analysis: any = null;
            let analysisError: { code: string; message: string } | null = null;
            let analysisPending = false;
            const wantsAnalysis = String(req.body?.analyze ?? req.query?.analyze ?? "true") !== "false";
            const category = req.body?.documentCategory ?? req.body?.category;
            if (wantsAnalysis && document?.Id && medSenseService.handles(category, prepared.buffer.length)) {
                try {
                    const pdf = await medicalReportAiService.asPdf(prepared);
                    await medSenseService.submit(Number(document.Id), pdf, prepared.fileName);
                    document.AiJobStatus = "processing";
                    analysisPending = true;
                } catch (err: any) {
                    console.error("[MobileMedicalDocument] MedSense submit failed, reading with Gemini:", err?.message);
                }
            }
            if (wantsAnalysis && !analysisPending) {
                try {
                    analysis = await medicalReportAiService.analyzeBuffer(prepared.buffer, prepared.mimeType, prepared.pageCount);
                    if (document?.Id && document.BlobUrl) {
                        await medicalReportAiService.saveAnalysis(Number(document.Id), analysis);
                        document.AiStatus = analysis.overallStatus;
                    }
                } catch (err: any) {
                    console.error("[MobileMedicalDocument] Report analysis failed:", err?.message);
                    analysisError = {
                        code: err instanceof ReportAnalysisError ? err.code : "AI_ERROR",
                        message: err instanceof ReportAnalysisError ? err.message : "The report was saved, but AI analysis failed. Try again from the document.",
                    };
                }
            }

            if (document) delete (document as any).AiAnalysis;
            return res.status(201).json(
                ApiResponse.success(
                    {
                        document,
                        analysis,
                        analysisError,
                        analysisPending,
                        pendingMessage: analysisPending ? ANALYSIS_PENDING_MESSAGE : null,
                        pageCount: prepared.pageCount,
                    },
                    "Report uploaded.",
                ),
            );
        } catch (error: any) {
            return this.sendError(res, error, "Mobile Medical Report Upload Error");
        }
    }

    /** Reads an existing document with AI; returns the saved result unless force=true. */
    async analyzeDocument(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));
            const force = String(req.body?.force ?? req.query?.force ?? "false") === "true";
            const loaded = await medicalReportAiService.loadStoredReport(id, this.requesterId(req), force);
            if ("cached" in loaded) return res.json(ApiResponse.success(loaded.cached, "Report analysed."));

            const { report, category } = loaded;
            // MedSense reads it in the background and the patient gets a push; Gemini reads it now if MedSense can't.
            if (medSenseService.handles(category, report.buffer.length)) {
                try {
                    const pdf = await medicalReportAiService.asPdf(report);
                    await medSenseService.submit(id, pdf, report.fileName);
                    // The same reply as asking while a job runs, which both apps already show as "analysing".
                    return res.status(409).json(ApiResponse.error(ANALYSIS_PENDING_MESSAGE, { code: "ANALYSIS_PENDING" }));
                } catch (err: any) {
                    console.error("[MobileMedicalDocument] MedSense submit failed, reading with Gemini:", err?.message);
                }
            }
            const analysis = await medicalReportAiService.analyzeBuffer(report.buffer, report.mimeType, report.pageCount);
            await medicalReportAiService.saveAnalysis(id, analysis);
            return res.json(ApiResponse.success(analysis, "Report analysed."));
        } catch (error: any) {
            return this.sendError(res, error, "Mobile Medical Document Analyze Error");
        }
    }

    async getAnalysis(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));
            const { AppDataSource } = await import("../../../../config/database.js");
            const { MedicalDocument } = await import("../../../../models/Appointments/medical-document.model.js");
            const doc = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } as any });
            if (!doc) return res.status(404).json(ApiResponse.error("Document not found"));
            if (!(await canOpenDocument(req, doc))) {
                return res.status(403).json(ApiResponse.error("You can only open reports you can see for this patient."));
            }
            const analysis = await medicalReportAiService.getStoredAnalysis(id);
            return res.json(ApiResponse.success(analysis, analysis ? "Analysis found." : "Not analysed yet."));
        } catch (error: any) {
            return this.sendError(res, error, "Mobile Medical Document Analysis Get Error");
        }
    }

    private requesterId(req: Request): string | undefined {
        const user = (req as any).user;
        const id = user?.userId || user?.id;
        return id ? String(id) : undefined;
    }

    private sendError(res: Response, error: any, label: string) {
        if (error instanceof ReportAnalysisError) {
            return res.status(error.httpStatus).json(ApiResponse.error(error.message, { code: error.code }));
        }
        console.error(`${label}:`, error);
        return res.status(500).json(ApiResponse.error("Something went wrong. Please try again."));
    }

    /**
     * POST /medical-documents/:id/share-whatsapp
     * Sends one document to the patient's WhatsApp (a link that opens it). Anyone
     * who can see the document may send it: the patient and family, a doctor the
     * patient gave access to, the hospital's staff, and a doctor for his own records.
     */
    async shareOnWhatsApp(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));
            if (!requireTokenActor(req, res)) return;
            const requesterId = await workingAccountId(req);
            if (!requesterId) return res.status(401).json(ApiResponse.error("Please sign in again."));

            const { AppDataSource } = await import("../../../../config/database.js");
            const { MedicalDocument } = await import("../../../../models/Appointments/medical-document.model.js");
            const doc = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id, IsDeleted: false } as any });
            if (!doc) return res.status(404).json(ApiResponse.error("Document not found"));
            if (!(await canOpenDocument(req, doc))) {
                return res.status(403).json(ApiResponse.error("You can only send documents you can see for this patient."));
            }

            const result = await medicalDocumentService.shareSingleDocument(id, String(doc.PatientId), requesterId);
            return res.json(ApiResponse.success({ sentCount: result?.docCount ?? 1 }, "Sent to the patient's WhatsApp."));
        } catch (error: any) {
            const message = String(error?.message || "");
            if (["Document not found.", "Patient not found.", "Patient does not have a registered mobile number."].includes(message)) {
                return res.status(400).json(ApiResponse.error(message));
            }
            console.error("Mobile Medical Document WhatsApp Share Error:", error);
            // The WhatsApp service throws when Meta refuses; its raw reply is not for the app.
            if (message.startsWith("WhatsApp Graph API error")) {
                return res.status(502).json(ApiResponse.error("WhatsApp couldn't deliver it right now. Please try again."));
            }
            return res.status(500).json(ApiResponse.error("Couldn't send it on WhatsApp. Please try again."));
        }
    }

    async deleteDocument(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid document ID"));
            }

            // Only the record's author, or the patient for records they added themselves.
            const { AppDataSource } = await import("../../../../config/database.js");
            const { MedicalDocument } = await import("../../../../models/Appointments/medical-document.model.js");
            const { canDeleteRecord, requesterIdOf } = await import("../../../../middlewares/record-ownership.js");
            const existing = await AppDataSource.getRepository(MedicalDocument).findOne({ where: { Id: id } as any });
            if (!existing) {
                return res.status(404).json(ApiResponse.error("Document not found"));
            }
            if (!(await canDeleteRecord(requesterIdOf(req), existing as any))) {
                return res.status(403).json(ApiResponse.error("You can only delete documents you added."));
            }

            // Record who deleted it from the login, not from a query parameter.
            await medicalDocumentService.deleteDocument(id, requesterIdOf(req));
            return res.json(ApiResponse.success(null, "Document deleted successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Delete Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileMedicalDocumentController = new MobileMedicalDocumentController();
