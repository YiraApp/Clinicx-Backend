import { timingSafeEqual } from "crypto";
import { medicalDocumentRepository } from "../../repositories/Appointments/medical-document.repository.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { pushNotificationService } from "../Notifications/push-notification.service.js";
import { medicalReportAiService } from "./medical-report-ai.service.js";

/**
 * Background report reading through MedSense. The upload returns at once,
 * MedSense calls our webhook when it has read the report, and the patient
 * gets a push. If MedSense hasn't answered in time, Gemini reads it instead.
 */

const MEDSENSE_MAX_BYTES = 10 * 1024 * 1024;

export const ANALYSIS_PENDING_MESSAGE =
    "We're analysing your report. This usually takes 2-3 minutes. We'll notify you when it's ready.";

class MedSenseService {
    private schedulerInterval: NodeJS.Timeout | null = null;

    private env(name: string): string {
        return (process.env[name] || "").trim();
    }

    private get baseUrl(): string {
        return (this.env("MEDSENSE_BASE_URL") || "https://api.yira.ai/api/v1").replace(/\/+$/, "");
    }

    private get timeoutMinutes(): number {
        const n = Number(process.env.MEDSENSE_TIMEOUT_MINUTES);
        return Number.isFinite(n) && n > 0 ? n : 10;
    }

    get isConfigured(): boolean {
        return ["MEDSENSE_API_KEY", "MEDSENSE_TENANT_ID", "MEDSENSE_PROJECT_ID", "MEDSENSE_WEBHOOK_SECRET", "MEDSENSE_WEBHOOK_BASE_URL"]
            .every((name) => this.env(name).length > 0);
    }

    /** Whether reports in [category] go to MedSense. An empty MEDSENSE_CATEGORIES means every category. */
    handles(category: string | undefined, sizeBytes: number): boolean {
        if (!this.isConfigured || sizeBytes > MEDSENSE_MAX_BYTES) return false;
        const allowed = this.env("MEDSENSE_CATEGORIES")
            .split(",")
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean);
        return allowed.length === 0 || allowed.includes((category || "").trim().toLowerCase());
    }

    /** Sends a PDF to MedSense and marks the document as processing. */
    async submit(documentId: number, pdf: Buffer, fileName: string): Promise<string> {
        const webhookUrl = `${this.env("MEDSENSE_WEBHOOK_BASE_URL").replace(/\/+$/, "")}/api/webhooks/medsense` +
            `?token=${encodeURIComponent(this.env("MEDSENSE_WEBHOOK_SECRET"))}`;
        const url = `${this.baseUrl}/tenants/${encodeURIComponent(this.env("MEDSENSE_TENANT_ID"))}` +
            `/projects/${encodeURIComponent(this.env("MEDSENSE_PROJECT_ID"))}/reports` +
            `?webhook_url=${encodeURIComponent(webhookUrl)}&unique_id=${documentId}`;

        const form = new FormData();
        const pdfName = fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName.replace(/\.[a-z0-9]{2,4}$/i, "")}.pdf`;
        form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), pdfName);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { accept: "application/json", "X-API-Key": this.env("MEDSENSE_API_KEY") },
                body: form,
                signal: controller.signal,
            });
            const body: any = await response.json().catch(() => null);
            if (!response.ok || !body?.job_id) {
                throw new Error(`MedSense ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
            }
            const jobId = String(body.job_id);
            await medicalDocumentRepository.startAiJob(documentId, jobId);
            console.log(`[MedSense] Document ${documentId} queued as job ${jobId}`);
            return jobId;
        } finally {
            clearTimeout(timer);
        }
    }

    isValidWebhookToken(token: unknown): boolean {
        const expected = Buffer.from(this.env("MEDSENSE_WEBHOOK_SECRET"));
        const given = Buffer.from(typeof token === "string" ? token : "");
        return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
    }

    /** Saves what MedSense found and tells the patient. Unknown or finished jobs are ignored. */
    async handleWebhook(payload: any): Promise<void> {
        const jobId = payload?.job_id ? String(payload.job_id) : "";
        if (!jobId) return;

        const doc = await medicalDocumentRepository.findByAiJobId(jobId);
        if (!doc) {
            console.warn(`[MedSense] Webhook for unknown job ${jobId}`);
            return;
        }

        const parsed = payload?.parsed_data;
        const usable = payload?.status === "completed" && parsed && typeof parsed === "object" &&
            (Array.isArray(parsed.sections) || typeof parsed.summary === "string");

        if (!usable) {
            console.warn(`[MedSense] Job ${jobId} returned status "${payload?.status}" without a usable result; reading with Gemini`);
            if (await medicalDocumentRepository.moveAiJob(Number(doc.Id), ["processing"], "fallback")) {
                await this.runFallback(doc);
            }
            return;
        }

        const analysis = medicalReportAiService.normalize(parsed, undefined, "medsense");
        if (!(await medicalDocumentRepository.moveAiJob(Number(doc.Id), ["processing", "fallback"], "done"))) return;
        await medicalReportAiService.saveAnalysis(Number(doc.Id), analysis);
        console.log(`[MedSense] Document ${doc.Id} analysed (job ${jobId}, ${analysis.overallStatus})`);
        await this.notify(doc, true);
    }

    /** Checks every [intervalSeconds] for jobs MedSense hasn't answered in time. */
    startScheduler(intervalSeconds: number = 60) {
        if (!this.isConfigured) {
            console.log("[MedSense] Not configured; reports are read with Gemini during upload.");
            return;
        }
        if (this.schedulerInterval) clearInterval(this.schedulerInterval);
        console.log(`[MedSense] Timeout checker started (every ${intervalSeconds}s, Gemini after ${this.timeoutMinutes} min)`);
        this.schedulerInterval = setInterval(() => {
            this.recoverStaleJobs().catch((err) => console.error("[MedSense] Timeout check failed:", err?.message || err));
        }, intervalSeconds * 1000);
    }

    stopScheduler() {
        if (this.schedulerInterval) {
            clearInterval(this.schedulerInterval);
            this.schedulerInterval = null;
        }
    }

    private async recoverStaleJobs() {
        const cutoff = new Date(Date.now() - this.timeoutMinutes * 60_000);
        const stale = await medicalDocumentRepository.findStaleAiJobs(cutoff);
        for (const doc of stale) {
            if (!(await medicalDocumentRepository.moveAiJob(Number(doc.Id), ["processing"], "fallback"))) continue;
            console.warn(`[MedSense] Job ${doc.AiJobId} for document ${doc.Id} timed out; reading with Gemini`);
            await this.runFallback(doc);
        }
    }

    private async runFallback(doc: MedicalDocument) {
        const id = Number(doc.Id);
        try {
            await medicalReportAiService.analyzeDocument(id, undefined, true);
            if (await medicalDocumentRepository.moveAiJob(id, ["fallback"], "done")) {
                await this.notify(doc, true);
            }
        } catch (err: any) {
            console.error(`[MedSense] Gemini fallback failed for document ${id}:`, err?.message || err);
            if (await medicalDocumentRepository.moveAiJob(id, ["fallback"], "failed")) {
                await this.notify(doc, false);
            }
        }
    }

    // The push shows on the lock screen, so it never includes results.
    private async notify(doc: MedicalDocument, ready: boolean) {
        const name = doc.OriginalFileName || doc.FileName || "your report";
        try {
            await pushNotificationService.sendNotification({
                userId: doc.PatientId,
                title: ready ? "Your report analysis is ready" : "We couldn't analyse your report",
                body: ready
                    ? `AI insights for "${name}" are ready. Tap to view.`
                    : `"${name}" is saved, but the analysis didn't finish. Open it to try again.`,
                type: ready ? "REPORT_ANALYSIS_READY" : "REPORT_ANALYSIS_FAILED",
                referenceId: String(doc.Id),
                route: "/patientDocuments",
                additionalData: { documentId: String(doc.Id) },
            });
        } catch (err: any) {
            console.error(`[MedSense] Could not notify patient for document ${doc.Id}:`, err?.message || err);
        }
    }
}

export const medSenseService = new MedSenseService();
