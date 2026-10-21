import { Request, Response } from "express";
import { medicalDocumentService } from "../../../../services/Appointments/medical-document.service.js";
import { medicalReportAiService, ReportAnalysisError } from "../../../../services/Appointments/medical-report-ai.service.js";
import { ANALYSIS_PENDING_MESSAGE, medSenseService } from "../../../../services/Appointments/medsense.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

export class MobileMedicalDocumentController {
    async getPatientDocuments(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const organizationId = req.query.organizationId ? Number(req.query.organizationId) : undefined;
            const hospitalId = req.query.hospitalId ? Number(req.query.hospitalId) : undefined;
            const appointmentId = req.query.appointmentId ? Number(req.query.appointmentId) : undefined;
            const limit = req.query.limit ? Number(req.query.limit) : undefined;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const result = await medicalDocumentService.getPatientDocuments(patientId, organizationId, hospitalId, appointmentId, limit);
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
            return res.status(200).json(ApiResponse.success([], "Uploaded with fallback context"));
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
            const analysis = await medicalReportAiService.analyzeDocument(id, this.requesterId(req), force);
            return res.json(ApiResponse.success(analysis, "Report analysed."));
        } catch (error: any) {
            return this.sendError(res, error, "Mobile Medical Document Analyze Error");
        }
    }

    async getAnalysis(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            if (isNaN(id)) return res.status(400).json(ApiResponse.error("Invalid document ID"));
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

    async deleteDocument(req: Request, res: Response) {
        try {
            const id = parseInt(req.params.id as string);
            const { userId } = req.query;

            if (isNaN(id)) {
                return res.status(400).json(ApiResponse.error("Invalid document ID"));
            }

            await medicalDocumentService.deleteDocument(id, userId as string);
            return res.json(ApiResponse.success(null, "Document deleted successfully."));
        } catch (error: any) {
            console.error("Mobile Medical Document Delete Error:", error);
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileMedicalDocumentController = new MobileMedicalDocumentController();
