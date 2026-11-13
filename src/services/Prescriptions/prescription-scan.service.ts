/**
 * Reads a prescription photo or PDF (up to 2 pages) with Gemini for the app's "Scan prescription".
 * It runs here, with the server's key, so the key never ships inside the app.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];

const PROMPT = `You are an expert medical prescription analysis assistant. Analyze this prescription image or PDF document (supporting up to 2 pages) and extract the information as JSON. Return ONLY the JSON object, no extra text.

{
  "doctorName": "string - doctor's full name as written on the prescription",
  "hospitalName": "string - clinic/hospital/healthcare center name if visible, empty string if not",
  "specialty": "string - medical specialty if mentioned (e.g., General Medicine, Cardiology, Dermatology, Pediatrics, Orthopedics, ENT, Gynecology, Dental). Default to General Medicine if unclear",
  "consultationDate": "string - date in YYYY-MM-DD format if visible, empty string if not",
  "diagnosis": "string - condition/diagnosis/symptoms/reason for visit. Combine multiple if present",
  "doctorNotes": "string - general advice, follow-up instructions, dietary instructions, or precautions",
  "medications": [
    {
      "name": "string - full medicine name with strength and formulation if visible (e.g., Tab Paracetamol 650mg, Cap Amoxicillin 500mg, Syp Corex 100ml)",
      "frequency": "string - one of: 1-0-1, 1-0-0, 0-0-1, 1-1-1, SOS. Map BD to 1-0-1, OD to 1-0-0, TDS/TID to 1-1-1, HS/ON to 0-0-1, SOS/PRN to SOS",
      "mealTiming": "string - one of: After Food, Before Food. Default to After Food if not specified",
      "durationDays": "number - duration in days. Convert weeks to days (e.g. 1 week = 7). Use 0 if continuous or unclear",
      "isContinuous": "boolean - true if medicine is marked as ongoing/continuous/lifelong",
      "notes": "string - any specific instructions for this medicine (e.g., Take with warm water)"
    }
  ],
  "confidence": "number 0-100 - your confidence in the extraction accuracy based on image clarity and handwriting legibility"
}

IMPORTANT RULES:
- FOR PDF DOCUMENTS (UP TO 2 PAGES): Carefully examine and extract details from BOTH Page 1 and Page 2 (if present). Combine all medications, dosages, and notes found across both pages into a single unified JSON response. Do not omit medications from either page. If more than 2 pages exist, analyze only the first 2 pages.
- Extract EVERY SINGLE medication visible in the prescription.
- If you see Rx or ℞ symbols, all items listed below are medications.
- If a field is not visible or unclear, use empty string for strings, 5 for durationDays, false for booleans.
- Map common abbreviations: Tab=Tablet, Cap=Capsule, Syp=Syrup, Inj=Injection, OD=1-0-0, BD=1-0-1, TDS/TID=1-1-1, HS=0-0-1, SOS=SOS, AC=Before Food, PC=After Food.
- Translate any non-English text to English.
- Return ONLY valid JSON, no markdown backticks, no explanation text.`;

export class PrescriptionScanError extends Error {
    constructor(message: string, public readonly code: string, public readonly httpStatus = 400) {
        super(message);
    }
}

/** Older phones send photos as application/octet-stream; trust the bytes, then the file name. */
export function scanMimeType(buffer: Buffer, declared?: string, fileName?: string): string | null {
    if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
    if (buffer.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
    if (buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return "image/heic";
    const type = (declared || "").toLowerCase();
    if (TYPES.includes(type)) return type;
    const ext = (fileName || "").toLowerCase().split(".").pop();
    const byExt: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", pdf: "application/pdf" };
    return ext && byExt[ext] ? byExt[ext] : null;
}

class PrescriptionScanService {
    private get apiKey() {
        return (process.env.GEMINI_API_KEY || "").trim();
    }

    private get model() {
        return (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
    }

    /** The extracted prescription, in the JSON shape the app's PrescriptionAnalysisResult reads. */
    async scan(file?: { buffer: Buffer; mimetype?: string; originalname?: string }): Promise<any> {
        if (!this.apiKey) throw new PrescriptionScanError("Prescription scanning is not set up on the server.", "NOT_CONFIGURED", 503);
        if (!file?.buffer?.length) throw new PrescriptionScanError("Add a photo or PDF of the prescription.", "NO_FILE");
        if (file.buffer.length > MAX_BYTES) throw new PrescriptionScanError("This file is too large. Use one under 10 MB.", "TOO_LARGE");
        const mimeType = scanMimeType(file.buffer, file.mimetype, file.originalname);
        if (!mimeType) throw new PrescriptionScanError("Only photos (JPG, PNG, WebP, HEIC) and PDFs can be scanned.", "UNSUPPORTED_TYPE");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        let response: Response;
        try {
            response = await fetch(`${GEMINI_URL}/${this.model}:generateContent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType, data: file.buffer.toString("base64") } }] }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
                }),
            });
        } catch (err: any) {
            throw err?.name === "AbortError"
                ? new PrescriptionScanError("Analysis is taking too long. Please try with a clearer image.", "TIMEOUT", 504)
                : new PrescriptionScanError("Could not reach the AI service. Please try again.", "AI_UNAVAILABLE", 502);
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "");
            console.error(`[PrescriptionScan] Gemini ${response.status}: ${body.slice(0, 300)}`);
            if (response.status === 429) throw new PrescriptionScanError("Service is busy right now. Please try again in a moment.", "RATE_LIMITED", 429);
            if (response.status === 400) throw new PrescriptionScanError("Could not process this image. Please try a clearer photo.", "BAD_IMAGE");
            throw new PrescriptionScanError("The AI service returned an error. Please try again.", "AI_ERROR", 502);
        }

        const json: any = await response.json();
        if (!json?.candidates?.length && json?.promptFeedback?.blockReason) {
            throw new PrescriptionScanError("Image was blocked by safety filters. Please try a different image.", "BLOCKED", 422);
        }
        const text = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || "").join("").trim();
        if (!text) throw new PrescriptionScanError("No data extracted from the prescription. Please try again.", "EMPTY", 422);
        try {
            const parsed = JSON.parse(text.replace(/^```\w*\s*/, "").replace(/\s*```$/, ""));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            return parsed;
        } catch {
            console.error("[PrescriptionScan] Unparseable reply:", text.slice(0, 200));
            throw new PrescriptionScanError("Could not understand the prescription. Please try a clearer image.", "PARSE_ERROR", 422);
        }
    }
}

export const prescriptionScanService = new PrescriptionScanService();
