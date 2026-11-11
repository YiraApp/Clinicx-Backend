import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import axios from "axios";
import { keepUnits, printableCopy } from "../../utils/pdf-text.js";

export interface PrescriptionPdfInput {
    hospital: {
        name?: string;
        address?: string;
        city?: string;
        state?: string;
        pincode?: string;
        helpline?: string;
        email?: string;
        website?: string;
        logoUrl?: string;
    };
    doctor: {
        name?: string;
        qualification?: string;
        specialty?: string;
        department?: string;
        registrationNumber?: string;
    };
    patient: {
        name?: string;
        patientId?: string;
        uhid?: string;
        age?: string | number;
        gender?: string;
        phoneNumber?: string;
        bloodGroup?: string;
    };
    prescription: {
        id?: string;
        prescriptionNumber?: number | string;
        date?: Date | string;
        appointmentId?: string;
        diagnoses?: string[];
        medications: Array<{
            name: string;
            dosage?: string;
            frequency?: string;
            duration?: string;
            route?: string;
            instructions?: string;
            note?: string;
        }>;
        labTests?: Array<{
            name: string;
            code?: string | null;
            category?: string | null;
            sampleType?: string | null;
            preparation?: string | null;
            priority?: string;
            instructions?: string | null;
        }>;
        notes?: string;
    };
    /** The visit's medical record, printed above the medicines when there is one. */
    clinicalRecord?: {
        chiefComplaint?: string | null;
        symptoms?: string | null;
        historyOfPresentIllness?: string | null;
        pastHistory?: string | null;
        currentMedications?: string | null;
        vitals?: {
            temperature?: string | null;
            pulse?: string | null;
            bloodPressure?: string | null;
            respiratoryRate?: string | null;
            spo2?: string | null;
            weight?: string | null;
            height?: string | null;
        };
        generalExamination?: string | null;
        cvs?: string | null;
        rs?: string | null;
        abdomen?: string | null;
        cns?: string | null;
        diagnosis?: string | null;
        diagnosisType?: string | null;
        treatment?: string | null;
        followUpDate?: Date | string | null;
    } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const filled = (value?: string | null) => (value ?? "").trim();
/** A vital with its unit when only the number was typed ("80" pulse is "80 /min"). */
function vitalText(value: string | null | undefined, unit: string): string {
    const v = filled(value);
    if (!v) return "";
    if (unit === "temp") {
        if (!/^\d+(\.\d+)?$/.test(v)) return v;
        return Number(v) >= 50 ? `${v} \u00b0F` : `${v} \u00b0C`;
    }
    if (unit === "mmHg") return /^\d{2,3}\s*\/\s*\d{2,3}$/.test(v) ? `${v.replace(/\s+/g, "")} mmHg` : v;
    return /^\d+(\.\d+)?$/.test(v) ? `${v} ${unit}` : v;
}
function shortDate(value?: Date | string | null): string {
    if (!value) return "";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function isValidImageBuffer(buf: Buffer): boolean {
    if (!buf || buf.length < 4) return false;
    // PNG signature: 89 50 4E 47
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    // JPEG signature: FF D8 FF
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return isPng || isJpg;
}

// One clean instruction per line: tidies the separators doctors type between lines, keeps every word.
function formatAdviceLines(notes?: string | null): string[] {
    const text = (notes || "").trim();
    if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") return [];
    return text
        .split(/\r?\n/)
        .map(line => line
            .replace(/\s+/g, " ")
            .replace(/,\s*&/g, " &")
            .replace(/^[\s,;.\u2022\u2026]+|[\s,;.\u2022\u2026]+$/g, ""))
        .filter(line => line.length > 0);
}

export class PrescriptionPdfService {
    /**
     * Generates a clean, professional digital prescription PDF Buffer using ONLY real database data.
     * No dummy placeholders, no fake IDs, no fake taglines, and no fake accreditation.
     */
    async generatePrescriptionPdf(input: PrescriptionPdfInput): Promise<Buffer> {
        // Characters the PDF fonts can't print (Telugu or Hindi script, emoji) would come out as junk.
        const data = printableCopy(input);
        return new Promise<Buffer>(async (resolve, reject) => {
            try {
                // A4 dimensions: 595.28 x 841.89 points
                const doc = new PDFDocument({
                    size: "A4",
                    margins: { top: 30, bottom: 30, left: 36, right: 36 },
                    autoFirstPage: true,
                    bufferPages: true,
                    info: {
                        Title: `Prescription - ${data.patient.name || "Patient"}`,
                        Author: data.doctor.name || "Doctor",
                        Subject: `Prescription ${data.prescription.id || "NA"}`,
                        Creator: "ClinX Health Systems"
                    }
                });

                const chunks: Buffer[] = [];
                doc.on("data", (chunk: Buffer) => chunks.push(chunk));
                doc.on("end", () => resolve(Buffer.concat(chunks)));
                doc.on("error", (err: Error) => reject(err));

                // ── Load Hospital Logo Buffer (real image or official fallback) ──
                let logoBuffer: Buffer | null = null;
                if (data.hospital.logoUrl && data.hospital.logoUrl.startsWith("http")) {
                    try {
                        const resp = await axios.get(data.hospital.logoUrl, {
                            responseType: "arraybuffer",
                            timeout: 4000
                        });
                        if (resp.data) {
                            const candidate = Buffer.from(resp.data);
                            if (isValidImageBuffer(candidate)) {
                                logoBuffer = candidate;
                            }
                        }
                    } catch (_) {
                        // ignore network failure
                    }
                }

                if (!logoBuffer) {
                    const fallbackPath = path.resolve(process.cwd(), "public/images/hospital_logo.png");
                    if (fs.existsSync(fallbackPath)) {
                        const localBuf = fs.readFileSync(fallbackPath);
                        if (isValidImageBuffer(localBuf)) {
                            logoBuffer = localBuf;
                        }
                    }
                }



                const pageWidth = 595.28;
                const margin = 36;
                const contentWidth = pageWidth - (margin * 2); // 523.28
                const footerY = 720;

                // ── Top Header Brand Accent Stripe ──
                doc.rect(0, 0, pageWidth, 5).fill("#1E3A8A");

                // ── Hospital Header Section ──
                let cursorY = 22;

                // Start a new page when the next block would run into the footer.
                const ensureRoom = (needed: number) => {
                    if (cursorY + needed > footerY - 14) {
                        doc.addPage();
                        cursorY = 36;
                    }
                };

                // Text is never cut short: blocks wrap, and boxes grow to fit what is in them.
                type Line = { text: string; font: string; size: number; color: string; gap?: number; align?: "left" | "center" | "right" };
                const stackHeight = (lines: Line[], width: number) =>
                    lines.reduce((h, l) => {
                        doc.font(l.font).fontSize(l.size);
                        return h + (l.gap ?? 0) + doc.heightOfString(l.text, { width });
                    }, 0);
                const drawStack = (lines: Line[], x: number, top: number, width: number) => {
                    let y = top;
                    for (const l of lines) {
                        y += l.gap ?? 0;
                        doc.font(l.font).fontSize(l.size).fillColor(l.color).text(l.text, x, y, { width, align: l.align ?? "left" });
                        y = doc.y;
                    }
                    return y;
                };

                // A titled panel of label / value rows (the clinical note). It grows to fit, and its rows
                // carry on to the next page under the repeated title when it doesn't fit.
                type Row = { label: string; value: string };
                const LABEL_WIDTH = 150;
                const valueWidth = contentWidth - LABEL_WIDTH - 12;
                const rowHeight = (row: Row) => {
                    doc.font("Helvetica-Bold").fontSize(8);
                    const labelHeight = doc.heightOfString(row.label, { width: LABEL_WIDTH - 20 });
                    doc.font("Helvetica").fontSize(8.5);
                    return Math.ceil(Math.max(labelHeight, doc.heightOfString(row.value, { width: valueWidth })) + 11);
                };
                const panelTitle = (title: string, tag: string, continued: boolean) => {
                    doc.roundedRect(margin, cursorY, contentWidth, 20, 4).fill("#EEF2FF");
                    doc.rect(margin, cursorY, 3, 20).fill("#1E3A8A");
                    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#1E3A8A")
                       .text(continued ? `${title} (continued)` : title, margin + 12, cursorY + 6, { width: contentWidth - 130 });
                    doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#64748B")
                       .text(tag, margin + contentWidth - 118, cursorY + 6.5, { width: 108, align: "right" });
                    cursorY += 20;
                };
                const drawPanel = (title: string, tag: string, rows: Row[], strip?: { height: number; draw: () => void }) => {
                    if (!rows.length && !strip) return;
                    ensureRoom(20 + (strip?.height ?? 0) + (rows.length ? rowHeight(rows[0]) : 0) + 4);
                    panelTitle(title, tag, false);
                    strip?.draw();
                    rows.forEach((row, index) => {
                        const height = rowHeight(row);
                        if (cursorY + height > footerY - 14) {
                            doc.addPage();
                            cursorY = 36;
                            panelTitle(title, tag, true);
                        }
                        if (index % 2 === 1) doc.rect(margin, cursorY, contentWidth, height).fill("#F8FAFC");
                        doc.moveTo(margin, cursorY + height).lineTo(margin + contentWidth, cursorY + height).strokeColor("#E2E8F0").lineWidth(0.5).stroke();
                        doc.font("Helvetica-Bold").fontSize(8).fillColor("#475569").text(row.label, margin + 12, cursorY + 6, { width: LABEL_WIDTH - 20 });
                        doc.font("Helvetica").fontSize(8.5).fillColor("#0F172A").text(row.value, margin + LABEL_WIDTH, cursorY + 5.5, { width: valueWidth });
                        cursorY += height;
                    });
                    cursorY += 12;
                };

                // Hospital Logo (Real Logo)
                if (logoBuffer) {
                    try {
                        doc.image(logoBuffer, margin, cursorY, { fit: [56, 56] });
                    } catch (imgErr) {
                        console.warn("[PrescriptionPdfService] Failed to draw logo image:", imgErr);
                    }
                }

                const headerTextX = margin + 66;
                const badgeWidth = 120;
                const headerTextWidth = contentWidth - 66 - badgeWidth - 8;

                // Hospital Name (Real Only, NA if not available)
                const hospName = (data.hospital.name && data.hospital.name.trim()) ? data.hospital.name.trim() : "NA";
                doc.fontSize(15)
                   .fillColor("#1E3A8A")
                   .font("Helvetica-Bold")
                   .text(hospName, headerTextX, cursorY + 2, { width: headerTextWidth });

                // Address (Real Only)
                const addressParts = [
                    data.hospital.address,
                    data.hospital.city,
                    data.hospital.state ? `${data.hospital.state} - ${data.hospital.pincode || ""}` : data.hospital.pincode
                ].filter(Boolean).map(s => String(s).trim()).filter(s => s.length > 0);

                const fullAddress = addressParts.length > 0 ? addressParts.join(", ") : "Address: NA";

                doc.fontSize(8)
                   .fillColor("#475569")
                   .font("Helvetica")
                   .text(fullAddress, headerTextX, doc.y + 4, { width: headerTextWidth });

                // Contacts (Real Only, NA if absent)
                const phoneText = (data.hospital.helpline && data.hospital.helpline.trim()) ? `Ph: ${data.hospital.helpline.trim()}` : "Ph: NA";
                const emailText = (data.hospital.email && data.hospital.email.trim()) ? `Email: ${data.hospital.email.trim()}` : "Email: NA";
                const webText = (data.hospital.website && data.hospital.website.trim()) ? `Web: ${data.hospital.website.trim()}` : "Web: NA";
                const contactLine = `${phoneText}  |  ${emailText}  |  ${webText}`;

                doc.fontSize(7.5)
                   .fillColor("#64748B")
                   .font("Helvetica")
                   .text(contactLine, headerTextX, doc.y + 3, { width: headerTextWidth });
                const headerBottom = doc.y;

                // Top Right Badge: DIGITAL PRESCRIPTION (NABH removed)
                const badgeX = pageWidth - margin - badgeWidth;
                const badgeY = cursorY + 8;

                doc.roundedRect(badgeX, badgeY, badgeWidth, 22, 4)
                   .fillAndStroke("#EFF6FF", "#BFDBFE");
                doc.fontSize(8)
                   .fillColor("#1E40AF")
                   .font("Helvetica-Bold")
                   .text("DIGITAL PRESCRIPTION", badgeX, badgeY + 7, { width: badgeWidth, align: "center" });

                // Divider line below the logo, or below the hospital's details when they run longer
                cursorY = Math.max(86, Math.ceil(headerBottom) + 8);
                doc.rect(margin, cursorY, contentWidth, 1.5).fill("#0284C7");
                doc.rect(margin, cursorY + 1.5, contentWidth, 0.5).fill("#E2E8F0");

                // ── Reference Bar (Prescription ID, Issued Date, Appointment ID) ──
                cursorY += 8;
                doc.roundedRect(margin, cursorY, contentWidth, 22, 4).fillAndStroke("#F0F9FF", "#E0F2FE");

                const formattedDate = data.prescription.date
                    ? new Date(data.prescription.date).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: true
                    })
                    : "NA";

                // Real Prescription ID (Numeric ID)
                const displayPrescriptionNumber = (data.prescription.prescriptionNumber !== undefined && data.prescription.prescriptionNumber !== null && String(data.prescription.prescriptionNumber).trim() !== "")
                    ? String(data.prescription.prescriptionNumber).trim()
                    : ((data.prescription.id && data.prescription.id.trim()) ? data.prescription.id.trim().substring(0, 8) : "NA");

                doc.fontSize(8.5)
                   .font("Helvetica-Bold")
                   .fillColor("#1E3A8A")
                   .text(`Prescription ID: ${displayPrescriptionNumber}`, margin + 10, cursorY + 6);

                doc.fontSize(8)
                   .font("Helvetica")
                   .fillColor("#334155")
                   .text(formattedDate === "NA" ? "Issued: NA" : `Issued: ${formattedDate} IST`, margin + 195, cursorY + 6);

                const rawApptId = data.prescription.appointmentId && data.prescription.appointmentId.trim() !== "0" && data.prescription.appointmentId.trim() !== ""
                    ? data.prescription.appointmentId.trim()
                    : "NA";

                doc.fontSize(8)
                   .font("Helvetica-Bold")
                   .fillColor("#0284C7")
                   .text(`Appt ID: #${rawApptId}`, margin + 370, cursorY + 6, {
                       width: contentWidth - 380,
                       align: "right"
                   });

                // ── Two-Column Patient & Doctor Identity Card ──
                cursorY += 28;
                // Both columns are measured first so the card is tall enough to show everything in full.
                const halfWidth = contentWidth / 2;
                const docColWidth = halfWidth - 24;
                const docQual = (data.doctor.qualification && data.doctor.qualification.trim()) ? data.doctor.qualification.trim() : "NA";
                const docSpec = (data.doctor.specialty && data.doctor.specialty.trim())
                    ? data.doctor.specialty.trim()
                    : ((data.doctor.department && data.doctor.department.trim()) ? data.doctor.department.trim() : "NA");
                const docReg = (data.doctor.registrationNumber && data.doctor.registrationNumber.trim())
                    ? data.doctor.registrationNumber.trim()
                    : "NA";
                const patientDisplayName = (data.patient.name && data.patient.name.trim()) ? data.patient.name.trim() : "NA";
                const ageText = (data.patient.age !== undefined && data.patient.age !== null && String(data.patient.age).trim() !== "")
                    ? `Age: ${data.patient.age} Yrs`
                    : "Age: NA";
                const genderText = (data.patient.gender && data.patient.gender.trim())
                    ? `Gender: ${data.patient.gender.trim()}`
                    : "Gender: NA";
                const bloodText = (data.patient.bloodGroup && data.patient.bloodGroup.trim())
                    ? `Blood: ${data.patient.bloodGroup.trim()}`
                    : "Blood: NA";
                const rawPatId = (data.patient.patientId && data.patient.patientId.trim()) ? data.patient.patientId.trim() : "";
                const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPatId);
                const realPatientId = (!rawPatId || isUuid || rawPatId.toUpperCase() === "NA") ? "NA" : rawPatId;
                const realPhone = (data.patient.phoneNumber && data.patient.phoneNumber.trim())
                    ? data.patient.phoneNumber.trim()
                    : "NA";
                const docRawName = (data.doctor.name && data.doctor.name.trim()) ? data.doctor.name.trim() : "NA";
                const docPrefix = (docRawName !== "NA" && !docRawName.toLowerCase().startsWith("dr")) ? "Dr. " : "";

                const patientLines: Line[] = [
                    { text: "PATIENT INFORMATION", font: "Helvetica-Bold", size: 7.5, color: "#0284C7" },
                    { text: patientDisplayName, font: "Helvetica-Bold", size: 10, color: "#0F172A", gap: 4 },
                    { text: `${ageText}  |  ${genderText}  |  ${bloodText}`, font: "Helvetica", size: 8, color: "#334155", gap: 3 },
                    { text: `Patient ID: ${realPatientId}  |  Ph: ${realPhone}`, font: "Helvetica", size: 8, color: "#64748B", gap: 2 },
                ];
                // Qualification, department and registration each on their own line, wrapping when long.
                const doctorLines: Line[] = [
                    { text: "CONSULTING DOCTOR", font: "Helvetica-Bold", size: 7.5, color: "#0284C7" },
                    { text: `${docPrefix}${docRawName}`, font: "Helvetica-Bold", size: 10, color: "#0F172A", gap: 4 },
                    { text: `Qual: ${docQual}`, font: "Helvetica", size: 8, color: "#334155", gap: 3 },
                    { text: `Dept: ${docSpec}`, font: "Helvetica", size: 8, color: "#334155", gap: 2 },
                    { text: `Reg No: ${docReg}`, font: "Helvetica-Bold", size: 8, color: "#1E40AF", gap: 3 },
                ];
                const cardHeight = Math.max(84, Math.ceil(8 + Math.max(stackHeight(patientLines, docColWidth), stackHeight(doctorLines, docColWidth)) + 10));
                doc.roundedRect(margin, cursorY, contentWidth, cardHeight, 6).fillAndStroke("#F8FAFC", "#E2E8F0");

                // Vertical Separator
                doc.moveTo(margin + halfWidth, cursorY + 6)
                   .lineTo(margin + halfWidth, cursorY + cardHeight - 6)
                   .strokeColor("#E2E8F0")
                   .lineWidth(1)
                   .stroke();

                drawStack(patientLines, margin + 12, cursorY + 8, docColWidth);
                drawStack(doctorLines, margin + halfWidth + 14, cursorY + 8, docColWidth);

                cursorY += cardHeight + 10;

                // ── The visit's medical record (C/O, H/O, examination, vitals) ──
                const record = data.clinicalRecord;
                const rxDiagnosisText = (data.prescription.diagnoses || []).join(", ").replace(/\s+/g, " ").trim().toLowerCase();
                if (record) {
                    const complaint = filled(record.chiefComplaint);
                    const symptoms = filled(record.symptoms);
                    const subjective: Row[] = [
                        { label: "Chief Complaints (C/O)", value: complaint },
                        { label: "Symptoms", value: symptoms && symptoms.toLowerCase() !== complaint.toLowerCase() ? symptoms : "" },
                        { label: "History of Present Illness (H/O)", value: filled(record.historyOfPresentIllness) },
                        { label: "Past / Comorbid History", value: filled(record.pastHistory) },
                        { label: "Current Medications", value: filled(record.currentMedications) },
                    ].filter(r => r.value);
                    drawPanel("CLINICAL HISTORY & PRESENTATION", "Subjective", subjective);

                    const v = record.vitals || {};
                    const vitals = [
                        { label: "TEMP", value: vitalText(v.temperature, "temp") },
                        { label: "PULSE", value: vitalText(v.pulse, "/min") },
                        { label: "BP", value: vitalText(v.bloodPressure, "mmHg") },
                        { label: "RR", value: vitalText(v.respiratoryRate, "/min") },
                        { label: "SPO2", value: vitalText(v.spo2, "%") },
                        { label: "WEIGHT", value: vitalText(v.weight, "kg") },
                        { label: "HEIGHT", value: vitalText(v.height, "cm") },
                    ].filter(t => t.value);
                    let strip: { height: number; draw: () => void } | undefined;
                    if (vitals.length) {
                        const gap = 6;
                        const tileWidth = (contentWidth - 20 - gap * (vitals.length - 1)) / vitals.length;
                        doc.font("Helvetica-Bold").fontSize(9.5);
                        const valueHeight = Math.max(...vitals.map(t => doc.heightOfString(keepUnits(t.value), { width: tileWidth - 12 })));
                        const tileHeight = Math.ceil(7 + 9 + 2 + valueHeight + 6);
                        strip = {
                            height: tileHeight + 14,
                            draw: () => {
                                const top = cursorY + 7;
                                vitals.forEach((t, i) => {
                                    const x = margin + 10 + i * (tileWidth + gap);
                                    doc.roundedRect(x, top, tileWidth, tileHeight, 4).fillAndStroke("#F8FAFC", "#E2E8F0");
                                    doc.font("Helvetica-Bold").fontSize(7).fillColor("#64748B").text(t.label, x + 6, top + 6, { width: tileWidth - 12 });
                                    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#0F172A").text(keepUnits(t.value), x + 6, top + 17, { width: tileWidth - 12 });
                                });
                                cursorY = top + tileHeight + 7;
                            },
                        };
                    }
                    const systemic = [
                        ["CVS", record.cvs], ["RS", record.rs], ["P/A", record.abdomen], ["CNS", record.cns],
                    ].filter(([, value]) => filled(value as string)).map(([name, value]) => `${name}: ${filled(value as string)}`);
                    const diagnosis = filled(record.diagnosis);
                    const diagnosisLabel = filled(record.diagnosisType).toLowerCase() === "confirmed" ? "Confirmed Diagnosis" : "Provisional Diagnosis";
                    const objective: Row[] = [
                        { label: "General Examination", value: filled(record.generalExamination) },
                        { label: "Systemic Examination", value: systemic.join("\n") },
                        // Not repeated when it is the same as the prescription's diagnosis below.
                        { label: diagnosisLabel, value: diagnosis && diagnosis.toLowerCase() !== rxDiagnosisText ? diagnosis : "" },
                    ].filter(r => r.value);
                    drawPanel("CLINICAL EXAMINATION & VITALS", "Objective", objective, strip);
                }

                // ── Diagnoses Section (if present) ──
                if (data.prescription.diagnoses && data.prescription.diagnoses.length > 0) {
                    // Split, trim and de-duplicate so stray separators (",viral pyrexia") don't show.
                    const validDiag: string[] = [];
                    for (const d of data.prescription.diagnoses) {
                        for (const part of String(d ?? "").split(/[,;]/)) {
                            const clean = part.trim();
                            if (clean && !validDiag.some(v => v.toLowerCase() === clean.toLowerCase())) validDiag.push(clean);
                        }
                    }
                    if (validDiag.length > 0) {
                        doc.fontSize(8).font("Helvetica");
                        ensureRoom(doc.heightOfString(`DIAGNOSIS / CLINICAL IMPRESSION: ${validDiag.join(", ")}`, { width: contentWidth }) + 10);
                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#475569")
                           .text("DIAGNOSIS / CLINICAL IMPRESSION: ", margin, cursorY, { continued: true, width: contentWidth })
                           .font("Helvetica")
                           .fillColor("#0F172A")
                           .text(validDiag.join(", "));

                        cursorY = doc.y + 10;
                    } else {
                        cursorY += 2;
                    }
                } else {
                    cursorY += 2;
                }

                // ── Rx Classical Prescription Section Header ──
                ensureRoom(26 + 20 + 30);
                doc.roundedRect(margin, cursorY, 26, 20, 4).fill("#1E3A8A");
                doc.fontSize(11)
                   .font("Helvetica-Bold")
                   .fillColor("#FFFFFF")
                   .text("Rx", margin, cursorY + 4, { width: 26, align: "center" });

                doc.fontSize(10.5)
                   .font("Helvetica-Bold")
                   .fillColor("#1E3A8A")
                   .text("PRESCRIBED MEDICATIONS & SCHEDULE", margin + 34, cursorY + 5);

                cursorY += 26;

                // ── Medications Table ──
                const colSnoWidth = 24;
                const colMedWidth = 145;
                const colDosageWidth = 75;
                const colFreqWidth = 105;
                const colDurWidth = 65;
                const colNoteWidth = contentWidth - (colSnoWidth + colMedWidth + colDosageWidth + colFreqWidth + colDurWidth); // ~109.28

                const colX = {
                    sno: margin,
                    med: margin + colSnoWidth,
                    dosage: margin + colSnoWidth + colMedWidth,
                    freq: margin + colSnoWidth + colMedWidth + colDosageWidth,
                    dur: margin + colSnoWidth + colMedWidth + colDosageWidth + colFreqWidth,
                    note: margin + colSnoWidth + colMedWidth + colDosageWidth + colFreqWidth + colDurWidth
                };

                // Table Header Row (drawn again at the top of each new page the table runs onto)
                const tableHeaderHeight = 20;
                const drawTableHeader = () => {
                    doc.roundedRect(margin, cursorY, contentWidth, tableHeaderHeight, 4).fill("#1E3A8A");
                    doc.fontSize(7.5)
                       .font("Helvetica-Bold")
                       .fillColor("#FFFFFF");
                    doc.text("#", colX.sno, cursorY + 6, { width: colSnoWidth, align: "center" });
                    doc.text("MEDICINE & FORM", colX.med + 5, cursorY + 6, { width: colMedWidth - 5 });
                    doc.text("DOSAGE / ROUTE", colX.dosage + 4, cursorY + 6, { width: colDosageWidth - 4 });
                    doc.text("FREQUENCY & TIMING", colX.freq + 4, cursorY + 6, { width: colFreqWidth - 4 });
                    doc.text("DURATION", colX.dur + 2, cursorY + 6, { width: colDurWidth - 4, align: "center" });
                    doc.text("NOTE", colX.note + 4, cursorY + 6, { width: colNoteWidth - 6 });
                    cursorY += tableHeaderHeight;
                };
                drawTableHeader();

                // Table Body Rows (Real data, NA if not specified)
                const meds = data.prescription.medications && data.prescription.medications.length > 0
                    ? data.prescription.medications
                    : [];

                if (meds.length === 0) {
                    doc.rect(margin, cursorY, contentWidth, 26).fill("#FFFFFF");
                    doc.fontSize(8)
                       .font("Helvetica")
                       .fillColor("#64748B")
                       .text(
                           data.prescription.labTests?.length ? "No medicines prescribed. See the lab tests below." : "No medications recorded.",
                           margin + 10,
                           cursorY + 9
                       );
                    cursorY += 26;
                } else {
                    for (let i = 0; i < meds.length; i++) {
                        const med = meds[i];
                        const medName = keepUnits((med.name && med.name.trim()) ? med.name.trim() : "NA");
                        const rawNote = (med.instructions && med.instructions.trim())
                            ? med.instructions.trim()
                            : ((med.note && med.note.trim()) ? med.note.trim() : "");
                        const noteText = rawNote.length > 0 ? keepUnits(rawNote) : "NA";
                        const routeText = (med.route && med.route.trim()) ? `Route: ${med.route.trim()}` : "Route: NA";
                        const dosageText = keepUnits((med.dosage && med.dosage.trim()) ? med.dosage.trim() : "NA");
                        const freqText = keepUnits((med.frequency && med.frequency.trim()) ? med.frequency.trim() : "NA");
                        const rawDur = (med.duration && String(med.duration).trim()) ? String(med.duration).trim() : "";
                        let durText = "NA";
                        if (rawDur.length > 0 && rawDur !== "0" && rawDur !== "0 Days" && rawDur.toLowerCase() !== "days") {
                            durText = keepUnits(/^\d+(\.\d+)?$/.test(rawDur) ? `${rawDur} Days` : rawDur);
                        }

                        // Every cell wraps in full, and the row is as tall as its tallest cell.
                        const nameHeight = doc.fontSize(8.5).font("Helvetica-Bold").heightOfString(medName, { width: colMedWidth - 8 });
                        const routeHeight = doc.fontSize(7).font("Helvetica").heightOfString(routeText, { width: colMedWidth - 8 });
                        const dosageHeight = doc.fontSize(8).font("Helvetica").heightOfString(dosageText, { width: colDosageWidth - 6 });
                        const freqHeight = doc.fontSize(8).font("Helvetica-Bold").heightOfString(freqText, { width: colFreqWidth - 6 });
                        const durHeight = doc.fontSize(8).font("Helvetica").heightOfString(durText, { width: colDurWidth - 4 });
                        const noteHeight = doc.fontSize(7.5).font("Helvetica").heightOfString(noteText, { width: colNoteWidth - 8 });
                        const rowHeight = Math.ceil(Math.max(
                            30,
                            7 + nameHeight + routeHeight + 6,
                            9 + dosageHeight + 6,
                            9 + freqHeight + 6,
                            9 + durHeight + 6,
                            6 + noteHeight + 6
                        ));
                        const isEven = i % 2 === 0;

                        if (cursorY + rowHeight > footerY - 14) {
                            doc.addPage();
                            cursorY = 36;
                            drawTableHeader();
                        }

                        // Row background
                        doc.rect(margin, cursorY, contentWidth, rowHeight)
                           .fill(isEven ? "#FFFFFF" : "#F8FAFC");

                        // Bottom border
                        doc.moveTo(margin, cursorY + rowHeight)
                           .lineTo(margin + contentWidth, cursorY + rowHeight)
                           .strokeColor("#E2E8F0")
                           .lineWidth(0.5)
                           .stroke();

                        // S.No.
                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#475569")
                           .text(String(i + 1), colX.sno, cursorY + 9, { width: colSnoWidth, align: "center" });

                        // Medicine Name, with the route under it however many lines the name took
                        doc.fontSize(8.5)
                           .font("Helvetica-Bold")
                           .fillColor("#0F172A")
                           .text(medName, colX.med + 5, cursorY + 5, { width: colMedWidth - 8 });
                        doc.fontSize(7)
                           .font("Helvetica")
                           .fillColor("#64748B")
                           .text(routeText, colX.med + 5, cursorY + 7 + Math.ceil(nameHeight), { width: colMedWidth - 8 });

                        // Dosage
                        doc.fontSize(8)
                           .font("Helvetica")
                           .fillColor("#1E293B")
                           .text(dosageText, colX.dosage + 4, cursorY + 9, { width: colDosageWidth - 6 });

                        // Frequency & Timing, in full
                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#0284C7")
                           .text(freqText, colX.freq + 4, cursorY + 9, { width: colFreqWidth - 6 });

                        // Duration (or "NA")
                        doc.fontSize(8)
                           .font("Helvetica")
                           .fillColor("#334155")
                           .text(durText, colX.dur + 2, cursorY + 9, { width: colDurWidth - 4, align: "center" });

                        // Note / Instructions (or "NA" if not available)
                        doc.fontSize(7.5)
                           .font("Helvetica")
                           .fillColor(noteText === "NA" ? "#94A3B8" : "#334155")
                           .text(noteText, colX.note + 4, cursorY + 6, { width: colNoteWidth - 8 });

                        cursorY += rowHeight;
                    }
                }

                // ── Lab Tests Section (Only when the doctor ordered tests): the test and its instructions ──
                const labTests = data.prescription.labTests || [];
                if (labTests.length > 0) {
                    cursorY += 16;
                    const labSnoWidth = 24;
                    const labTestWidth = 230;
                    const labNoteWidth = contentWidth - labSnoWidth - labTestWidth;
                    const labX = { sno: margin, test: margin + labSnoWidth, note: margin + labSnoWidth + labTestWidth };
                    const labRows = labTests.map(test => {
                        const name = keepUnits(filled(test.name) || "NA");
                        // The doctor's instructions, then the hospital's preparation notes for the test.
                        const instructions = keepUnits(filled(test.instructions));
                        const preparation = keepUnits(filled(test.preparation));
                        const nameHeight = doc.font("Helvetica-Bold").fontSize(8.5).heightOfString(name, { width: labTestWidth - 10 });
                        const instructionsHeight = instructions ? doc.font("Helvetica").fontSize(8).heightOfString(instructions, { width: labNoteWidth - 12 }) : 0;
                        const preparationHeight = preparation ? doc.font("Helvetica-Oblique").fontSize(7.5).heightOfString(`Prep: ${preparation}`, { width: labNoteWidth - 12 }) + (instructions ? 2 : 0) : 0;
                        const height = Math.ceil(Math.max(24, 7 + nameHeight + 7, 7 + Math.max(instructionsHeight + preparationHeight, 9) + 7));
                        return { name, instructions, preparation, instructionsHeight, height };
                    });

                    const drawLabHeader = () => {
                        doc.roundedRect(margin, cursorY, contentWidth, 20, 4).fill("#1E3A8A");
                        doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#FFFFFF");
                        doc.text("#", labX.sno, cursorY + 6, { width: labSnoWidth, align: "center" });
                        doc.text("TEST", labX.test + 5, cursorY + 6, { width: labTestWidth - 10 });
                        doc.text("INSTRUCTIONS", labX.note + 6, cursorY + 6, { width: labNoteWidth - 12 });
                        cursorY += 20;
                    };

                    // Heading, table header and the first row stay together.
                    ensureRoom(26 + 20 + labRows[0].height);
                    doc.roundedRect(margin, cursorY, 30, 20, 4).fill("#1E3A8A");
                    doc.font("Helvetica-Bold").fontSize(9).fillColor("#FFFFFF").text("Lab", margin, cursorY + 5.5, { width: 30, align: "center" });
                    doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#1E3A8A").text("LAB TESTS ADVISED", margin + 38, cursorY + 5);
                    cursorY += 26;
                    drawLabHeader();

                    labRows.forEach((row, index) => {
                        if (cursorY + row.height > footerY - 14) {
                            doc.addPage();
                            cursorY = 36;
                            drawLabHeader();
                        }
                        doc.rect(margin, cursorY, contentWidth, row.height).fill(index % 2 === 0 ? "#FFFFFF" : "#F8FAFC");
                        doc.moveTo(margin, cursorY + row.height).lineTo(margin + contentWidth, cursorY + row.height).strokeColor("#E2E8F0").lineWidth(0.5).stroke();
                        doc.font("Helvetica-Bold").fontSize(8).fillColor("#475569").text(String(index + 1), labX.sno, cursorY + 7.5, { width: labSnoWidth, align: "center" });
                        doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#0F172A").text(row.name, labX.test + 5, cursorY + 7, { width: labTestWidth - 10 });
                        let noteY = cursorY + 7;
                        if (row.instructions) {
                            doc.font("Helvetica").fontSize(8).fillColor("#334155").text(row.instructions, labX.note + 6, noteY, { width: labNoteWidth - 12 });
                            noteY += row.instructionsHeight + 2;
                        }
                        if (row.preparation) {
                            doc.font("Helvetica-Oblique").fontSize(7.5).fillColor("#64748B").text(`Prep: ${row.preparation}`, labX.note + 6, noteY, { width: labNoteWidth - 12 });
                        }
                        if (!row.instructions && !row.preparation) {
                            doc.font("Helvetica").fontSize(8).fillColor("#94A3B8").text("-", labX.note + 6, noteY, { width: labNoteWidth - 12 });
                        }
                        cursorY += row.height;
                    });
                }

                // ── Plan and follow-up from the medical record ──
                if (record) {
                    const plan: Row[] = [
                        { label: "Treatment Plan", value: filled(record.treatment) },
                        { label: "Follow-up", value: shortDate(record.followUpDate) },
                    ].filter(r => r.value);
                    if (plan.length) {
                        cursorY += 14;
                        drawPanel("PLAN & FOLLOW-UP", "", plan);
                        cursorY -= 12;
                    }
                }

                // ── Additional Notes / Advice Section (Only if present in DB) ──
                cursorY += 14;
                const adviceLines = formatAdviceLines(data.prescription.notes);
                if (adviceLines.length > 0) {
                    // The box grows with the advice and, when it doesn't fit, carries on to the next page.
                    const adviceTextWidth = contentWidth - 24;
                    doc.fontSize(8.5).font("Helvetica");
                    const lineHeights = adviceLines.map(line => doc.heightOfString(line, { width: adviceTextWidth }) + 3);
                    let next = 0;
                    let firstPart = true;
                    while (next < adviceLines.length) {
                        ensureRoom(20 + lineHeights[next] + 6);
                        const top = cursorY;
                        let height = 20;
                        let last = next;
                        while (last < adviceLines.length && (last === next || top + height + lineHeights[last] + 6 <= footerY - 14)) {
                            height += lineHeights[last];
                            last++;
                        }
                        const adviceBoxHeight = Math.ceil(height + 6);

                        doc.roundedRect(margin, top, contentWidth, adviceBoxHeight, 5)
                           .fillAndStroke("#FFFBEB", "#FDE68A");

                        // Amber left accent bar
                        doc.roundedRect(margin, top, 4, adviceBoxHeight, 2).fill("#D97706");

                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#92400E")
                           .text(`DOCTOR'S ADVICE & FOLLOW-UP INSTRUCTIONS${firstPart ? "" : " (continued)"}`, margin + 12, top + 7, { width: adviceTextWidth });

                        doc.fontSize(8.5)
                           .font("Helvetica")
                           .fillColor("#78350F");
                        let adviceY = top + 20;
                        for (let k = next; k < last; k++) {
                            doc.text(adviceLines[k], margin + 12, adviceY, { width: adviceTextWidth });
                            adviceY += lineHeights[k];
                        }

                        cursorY = top + adviceBoxHeight + 14;
                        next = last;
                        firstPart = false;
                    }
                } else {
                    cursorY += 8;
                }

                // ── Footer Section: Positioned safely at bottom ──
                // Separator line above footer
                doc.rect(margin, footerY - 10, contentWidth, 0.75).fill("#CBD5E1");

                // Left: Standard clinical advisory notice
                doc.fontSize(7.5)
                   .font("Helvetica-Oblique")
                   .fillColor("#64748B")
                   .text(
                       "Note: Prescribed medicines must be taken strictly as per the advised schedule.\n" +
                       "For any adverse effects or clarification, contact the hospital immediately.",
                       margin,
                       footerY + 14,
                       { width: contentWidth - 190, lineGap: 3 }
                   );

                // Right: Digital Signature Seal, tall enough for the doctor's full name
                const sigBoxWidth = 160;
                const sigBoxX = pageWidth - margin - sigBoxWidth;
                const signTimestamp = formattedDate !== "NA" ? formattedDate : new Date().toLocaleDateString("en-IN");
                const sigLines: Line[] = [
                    { text: "DIGITALLY SIGNED & VERIFIED", font: "Helvetica-Bold", size: 7.5, color: "#166534", align: "center" },
                    { text: `${docPrefix}${docRawName}`, font: "Helvetica-Bold", size: 9, color: "#0F172A", gap: 3, align: "center" },
                    { text: `Reg No: ${docReg}`, font: "Helvetica", size: 7, color: "#166534", gap: 2, align: "center" },
                    { text: `Signed: ${signTimestamp}`, font: "Helvetica-Oblique", size: 6.5, color: "#64748B", gap: 2, align: "center" },
                ];
                const sigBoxHeight = Math.max(58, Math.ceil(stackHeight(sigLines, sigBoxWidth - 12) + 12));
                // Normally just under the separator; a very long name grows the box upwards, never past the page number.
                const sigBoxY = Math.min(footerY - 4, 788 - sigBoxHeight);

                doc.roundedRect(sigBoxX, sigBoxY, sigBoxWidth, sigBoxHeight, 5)
                   .fillAndStroke("#F0FDF4", "#BBF7D0");
                drawStack(sigLines, sigBoxX + 6, sigBoxY + 6, sigBoxWidth - 12);

                // Bottom Page Tracker
                const { start: firstPage, count: pageCount } = doc.bufferedPageRange();
                for (let i = 0; i < pageCount; i++) {
                    doc.switchToPage(firstPage + i);
                    doc.fontSize(7)
                       .font("Helvetica")
                       .fillColor("#94A3B8")
                       .text(`Page ${i + 1} of ${pageCount}  |  Official Electronic Health Record`, margin, 794, {
                           width: contentWidth,
                           align: "center"
                       });
                }

                doc.end();
            } catch (err) {
                console.error("[PrescriptionPdfService] Fatal PDF generation error:", err);
                reject(err);
            }
        });
    }
}

export const prescriptionPdfService = new PrescriptionPdfService();
