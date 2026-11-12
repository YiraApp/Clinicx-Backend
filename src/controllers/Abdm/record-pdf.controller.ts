import type { Request, Response } from "express";
import { ApiResponse } from "../../utils/response.utils.js";
import { FhirSourceError } from "../../services/Abdm/fhir/fhir-common.js";
import {
    isRecordPdfType, RecordPdfError, recordPdfService, type RecordPdfOut, type RecordPdfService,
} from "../../services/Abdm/record-pdf-preview.service.js";
import { recordPdfArchive, type RecordPdfVersions } from "../../services/Abdm/m2/record-pdf-archive.js";

/**
 * The PDF each record carries to ABDM, for staff: previewed from a form before it is saved, viewed
 * for a saved record at any time, and every stored version of it. Behind abdmHospitalStaff, so the
 * hospital is x-hospital-id's and the caller works there. PDFs are never cached, and the API log
 * keeps only an ABDM route's status and message.
 */

const hospitalOf = (req: Request): number => Number(req.headers["x-hospital-id"]);
const staffOf = (req: Request): string | null => ((req as any).userId ? String((req as any).userId) : null);

const sendPdf = (res: Response, data: Buffer, filename: string, status?: "draft" | "final") => {
    res.setHeader("Content-Type", "application/pdf");
    // No patient detail in the file name
    res.setHeader("Content-Disposition", `inline; filename="${filename}.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (status) {
        res.setHeader("X-Record-Status", status);
        res.setHeader("Access-Control-Expose-Headers", "X-Record-Status");
    }
    return res.status(200).send(data);
};

const sendOut = (res: Response, out: RecordPdfOut) => sendPdf(res, out.pdf.data, out.hiType, out.draft ? "draft" : "final");

const sendError = (res: Response, error: any) => {
    if (error instanceof RecordPdfError) {
        return res.status(error.status).json(ApiResponse.error(error.message, error.status === 422 ? { kind: "record" } : null));
    }
    // The record can't be built as it stands (a Final report with no conclusion, say): say what is missing
    if (error instanceof FhirSourceError) return res.status(422).json(ApiResponse.error(error.message, { kind: "record" }));
    if (/not found/i.test(error?.message ?? "")) return res.status(404).json(ApiResponse.error(error.message));
    console.error("[ABDM] record PDF failed:", error?.message);
    return res.status(500).json(ApiResponse.error("The record's PDF could not be made.", { kind: "unexpected" }));
};

const optionalId = (value: unknown): string | null => {
    const s = value === undefined || value === null ? "" : String(value).trim();
    return s ? s : null;
};

export class RecordPdfController {
    constructor(
        private readonly records: Pick<RecordPdfService, "preview" | "saved" | "locate"> = recordPdfService,
        private readonly archive: RecordPdfVersions = recordPdfArchive,
    ) {}

    /** POST .../record-pdf/preview: the PDF a form's unsaved fields would make. Saves nothing. */
    async preview(req: Request, res: Response) {
        res.setHeader("Cache-Control", "no-store");
        try {
            const { type, draft, appointmentId, recordId, billId } = req.body ?? {};
            if (!isRecordPdfType(type)) throw new RecordPdfError(400, "type must be one of the record types a PDF is made for.");
            if (type !== "invoice" && (typeof draft !== "object" || draft === null || Array.isArray(draft))) {
                throw new RecordPdfError(400, "draft must be the form's fields.");
            }
            const appointment = optionalId(appointmentId);
            const out = await this.records.preview({
                type,
                draft: draft ?? {},
                patientId: String(req.params.userId),
                hospitalId: hospitalOf(req),
                staffUserId: staffOf(req),
                appointmentId: appointment && /^\d+$/.test(appointment) ? Number(appointment) : null,
                recordId: optionalId(recordId),
                billId: optionalId(billId),
            });
            return sendOut(res, out);
        } catch (error) {
            return sendError(res, error);
        }
    }

    /** GET .../record-pdf/:type/:id: a saved record's PDF as ABDM gets it (a Draft as it will be). */
    async saved(req: Request, res: Response) {
        res.setHeader("Cache-Control", "no-store");
        try {
            const type = req.params.type;
            if (!isRecordPdfType(type)) throw new RecordPdfError(404, "No PDF is made for that kind of record.");
            const out = await this.records.saved({ type, id: String(req.params.id), patientId: String(req.params.userId), hospitalId: hospitalOf(req) });
            return sendOut(res, out);
        } catch (error) {
            return sendError(res, error);
        }
    }

    /** GET .../record-pdf/:type/:id/versions: every stored version of the record's PDF, newest first. */
    async versions(req: Request, res: Response) {
        res.setHeader("Cache-Control", "no-store");
        try {
            const type = req.params.type;
            if (!isRecordPdfType(type)) throw new RecordPdfError(404, "No PDF is made for that kind of record.");
            const loc = await this.records.locate({ type, id: String(req.params.id), patientId: String(req.params.userId), hospitalId: hospitalOf(req) });
            const versions = await this.archive.versions(hospitalOf(req), loc);
            return res.json(ApiResponse.success(versions.map((v) => ({ id: v.id, createdAt: v.createdAt.toISOString(), bytes: v.bytes, source: v.source }))));
        } catch (error) {
            return sendError(res, error);
        }
    }

    /** GET .../record-pdf/:type/:id/versions/:versionId: one stored version, byte for byte. */
    async version(req: Request, res: Response) {
        res.setHeader("Cache-Control", "no-store");
        try {
            const type = req.params.type;
            if (!isRecordPdfType(type)) throw new RecordPdfError(404, "No PDF is made for that kind of record.");
            const loc = await this.records.locate({ type, id: String(req.params.id), patientId: String(req.params.userId), hospitalId: hospitalOf(req) });
            const data = await this.archive.version(hospitalOf(req), loc, String(req.params.versionId));
            if (!data) throw new RecordPdfError(404, "That stored version isn't one of this record's.");
            return sendPdf(res, data, `${loc.hiType}-version`);
        } catch (error) {
            return sendError(res, error);
        }
    }
}

export const recordPdfController = new RecordPdfController();
