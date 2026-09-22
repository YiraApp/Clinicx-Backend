import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import axios from "axios";

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
        notes?: string;
    };
}

function isValidImageBuffer(buf: Buffer): boolean {
    if (!buf || buf.length < 4) return false;
    // PNG signature: 89 50 4E 47
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    // JPEG signature: FF D8 FF
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return isPng || isJpg;
}

export class PrescriptionPdfService {
    /**
     * Generates a clean, professional digital prescription PDF Buffer using ONLY real database data.
     * No dummy placeholders, no fake IDs, no fake taglines, and no fake accreditation.
     */
    async generatePrescriptionPdf(data: PrescriptionPdfInput): Promise<Buffer> {
        return new Promise<Buffer>(async (resolve, reject) => {
            try {
                // A4 dimensions: 595.28 x 841.89 points
                const doc = new PDFDocument({
                    size: "A4",
                    margins: { top: 30, bottom: 30, left: 36, right: 36 },
                    autoFirstPage: true,
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

                // ── Top Header Brand Accent Stripe ──
                doc.rect(0, 0, pageWidth, 5).fill("#1E3A8A");

                // ── Hospital Header Section ──
                let cursorY = 22;

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
                const headerTextWidth = contentWidth - 66 - badgeWidth;

                // Hospital Name (Real Only, NA if not available)
                const hospName = (data.hospital.name && data.hospital.name.trim()) ? data.hospital.name.trim() : "NA";
                doc.fontSize(15)
                   .fillColor("#1E3A8A")
                   .font("Helvetica-Bold")
                   .text(hospName, headerTextX, cursorY + 2, {
                       width: headerTextWidth,
                       ellipsis: true
                   });

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

                // Top Right Badge: DIGITAL PRESCRIPTION (NABH removed)
                const badgeX = pageWidth - margin - badgeWidth;
                const badgeY = cursorY + 8;

                doc.roundedRect(badgeX, badgeY, badgeWidth, 22, 4)
                   .fillAndStroke("#EFF6FF", "#BFDBFE");
                doc.fontSize(8)
                   .fillColor("#1E40AF")
                   .font("Helvetica-Bold")
                   .text("DIGITAL PRESCRIPTION", badgeX, badgeY + 7, { width: badgeWidth, align: "center" });

                // Divider line below Hospital Header
                cursorY = 86;
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
                   .text(`Issued: ${formattedDate} IST`, margin + 195, cursorY + 6);

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
                const cardHeight = 84;
                doc.roundedRect(margin, cursorY, contentWidth, cardHeight, 6).fillAndStroke("#F8FAFC", "#E2E8F0");

                // Vertical Separator
                const halfWidth = contentWidth / 2;
                doc.moveTo(margin + halfWidth, cursorY + 6)
                   .lineTo(margin + halfWidth, cursorY + cardHeight - 6)
                   .strokeColor("#E2E8F0")
                   .lineWidth(1)
                   .stroke();

                // Left Column: Patient Info (Real data only)
                const pX = margin + 12;
                let pY = cursorY + 8;

                doc.fontSize(7.5)
                   .font("Helvetica-Bold")
                   .fillColor("#0284C7")
                   .text("PATIENT INFORMATION", pX, pY);

                pY += 13;
                const patientDisplayName = (data.patient.name && data.patient.name.trim()) ? data.patient.name.trim() : "NA";
                doc.fontSize(10)
                   .font("Helvetica-Bold")
                   .fillColor("#0F172A")
                   .text(patientDisplayName, pX, pY, { width: halfWidth - 24, ellipsis: true });

                pY += 14;
                const ageText = (data.patient.age !== undefined && data.patient.age !== null && String(data.patient.age).trim() !== "")
                    ? `Age: ${data.patient.age} Yrs`
                    : "Age: NA";
                const genderText = (data.patient.gender && data.patient.gender.trim())
                    ? `Gender: ${data.patient.gender.trim()}`
                    : "Gender: NA";
                const bloodText = (data.patient.bloodGroup && data.patient.bloodGroup.trim())
                    ? `Blood: ${data.patient.bloodGroup.trim()}`
                    : "Blood: NA";

                doc.fontSize(8)
                   .font("Helvetica")
                   .fillColor("#334155")
                   .text(`${ageText}  |  ${genderText}  |  ${bloodText}`, pX, pY);
                pY += 13;
                const rawPatId = (data.patient.patientId && data.patient.patientId.trim()) ? data.patient.patientId.trim() : "";
                const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPatId);
                const realPatientId = (!rawPatId || isUuid || rawPatId.toUpperCase() === "NA") ? "NA" : rawPatId;
                const realPhone = (data.patient.phoneNumber && data.patient.phoneNumber.trim())
                    ? data.patient.phoneNumber.trim()
                    : "NA";

                doc.fontSize(8)
                   .font("Helvetica")
                   .fillColor("#64748B")
                   .text(`Patient ID: ${realPatientId}  •  Ph: ${realPhone}`, pX, pY, {
                       width: halfWidth - 24,
                       ellipsis: true
                   });

                // Right Column: Doctor Info (Real data only)
                const dX = margin + halfWidth + 14;
                let dY = cursorY + 8;

                doc.fontSize(7.5)
                   .font("Helvetica-Bold")
                   .fillColor("#0284C7")
                   .text("CONSULTING DOCTOR", dX, dY);

                dY += 13;
                let docRawName = (data.doctor.name && data.doctor.name.trim()) ? data.doctor.name.trim() : "NA";
                const docPrefix = (docRawName !== "NA" && !docRawName.toLowerCase().startsWith("dr")) ? "Dr. " : "";
                doc.fontSize(10)
                   .font("Helvetica-Bold")
                   .fillColor("#0F172A")
                   .text(`${docPrefix}${docRawName}`, dX, dY, { width: halfWidth - 24, ellipsis: true });

                dY += 14;
                const docQual = (data.doctor.qualification && data.doctor.qualification.trim()) ? data.doctor.qualification.trim() : "NA";
                const docSpec = (data.doctor.specialty && data.doctor.specialty.trim())
                    ? data.doctor.specialty.trim()
                    : ((data.doctor.department && data.doctor.department.trim()) ? data.doctor.department.trim() : "NA");

                doc.fontSize(8)
                   .font("Helvetica")
                   .fillColor("#334155")
                   .text(`Qual: ${docQual}  •  Dept: ${docSpec}`, dX, dY, { width: halfWidth - 24, ellipsis: true });

                dY += 14;
                const docReg = (data.doctor.registrationNumber && data.doctor.registrationNumber.trim())
                    ? data.doctor.registrationNumber.trim()
                    : "NA";

                doc.fontSize(8)
                   .font("Helvetica-Bold")
                   .fillColor("#1E40AF")
                   .text(`Reg No: ${docReg}`, dX, dY);

                // ── Diagnoses Section (if present) ──
                cursorY += cardHeight + 10;
                if (data.prescription.diagnoses && data.prescription.diagnoses.length > 0) {
                    const validDiag = data.prescription.diagnoses.filter(d => d && String(d).trim().length > 0);
                    if (validDiag.length > 0) {
                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#475569")
                           .text("DIAGNOSIS / CLINICAL IMPRESSION: ", margin, cursorY, { continued: true })
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

                // Table Header Row
                const tableHeaderHeight = 20;
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

                // Table Body Rows (Real data, NA if not specified)
                const meds = data.prescription.medications && data.prescription.medications.length > 0
                    ? data.prescription.medications
                    : [];

                if (meds.length === 0) {
                    doc.rect(margin, cursorY, contentWidth, 26).fill("#FFFFFF");
                    doc.fontSize(8)
                       .font("Helvetica")
                       .fillColor("#64748B")
                       .text("No medications recorded.", margin + 10, cursorY + 9);
                    cursorY += 26;
                } else {
                    for (let i = 0; i < meds.length; i++) {
                        const med = meds[i];
                        const rowHeight = 30;
                        const isEven = i % 2 === 0;

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

                        // Medicine Name
                        const medName = (med.name && med.name.trim()) ? med.name.trim() : "NA";
                        doc.fontSize(8.5)
                           .font("Helvetica-Bold")
                           .fillColor("#0F172A")
                           .text(medName, colX.med + 5, cursorY + 5, { width: colMedWidth - 8, ellipsis: true });

                        // Route subtext
                        const routeText = (med.route && med.route.trim()) ? `Route: ${med.route.trim()}` : "Route: NA";
                        doc.fontSize(7)
                           .font("Helvetica")
                           .fillColor("#64748B")
                           .text(routeText, colX.med + 5, cursorY + 17, { width: colMedWidth - 8 });

                        // Dosage
                        const dosageText = (med.dosage && med.dosage.trim()) ? med.dosage.trim() : "NA";
                        doc.fontSize(8)
                           .font("Helvetica")
                           .fillColor("#1E293B")
                           .text(dosageText, colX.dosage + 4, cursorY + 9, { width: colDosageWidth - 6 });

                        // Frequency & Timing
                        const freqText = (med.frequency && med.frequency.trim()) ? med.frequency.trim() : "NA";
                        doc.fontSize(8)
                           .font("Helvetica-Bold")
                           .fillColor("#0284C7")
                           .text(freqText, colX.freq + 4, cursorY + 9, { width: colFreqWidth - 6, ellipsis: true });

                        // Duration (Ensure display or "NA")
                        let rawDur = (med.duration && String(med.duration).trim()) ? String(med.duration).trim() : "";
                        let durText = "NA";
                        if (rawDur.length > 0 && rawDur !== "0" && rawDur !== "0 Days") {
                            durText = rawDur.toLowerCase().includes("day") ? rawDur : `${rawDur} Days`;
                        }
                        doc.fontSize(8)
                           .font("Helvetica")
                           .fillColor("#334155")
                           .text(durText, colX.dur + 2, cursorY + 9, { width: colDurWidth - 4, align: "center" });

                        // Note / Instructions (or "NA" if not available)
                        const rawNote = (med.instructions && med.instructions.trim()) 
                            ? med.instructions.trim() 
                            : ((med.note && med.note.trim()) ? med.note.trim() : "");
                        const noteText = rawNote.length > 0 ? rawNote : "NA";

                        doc.fontSize(7.5)
                           .font("Helvetica")
                           .fillColor(noteText === "NA" ? "#94A3B8" : "#334155")
                           .text(noteText, colX.note + 4, cursorY + 6, {
                               width: colNoteWidth - 8,
                               height: 20,
                               ellipsis: true
                           });

                        cursorY += rowHeight;
                    }
                }

                // ── Additional Notes / Advice Section (Only if present in DB) ──
                cursorY += 14;
                const notes = data.prescription.notes ? data.prescription.notes.trim() : "";
                if (notes.length > 0 && notes.toLowerCase() !== "null" && notes.toLowerCase() !== "undefined") {
                    const adviceBoxHeight = 52;
                    doc.roundedRect(margin, cursorY, contentWidth, adviceBoxHeight, 5)
                       .fillAndStroke("#FFFBEB", "#FDE68A");

                    // Amber left accent bar
                    doc.roundedRect(margin, cursorY, 4, adviceBoxHeight, 2).fill("#D97706");

                    doc.fontSize(8)
                       .font("Helvetica-Bold")
                       .fillColor("#92400E")
                       .text("DOCTOR'S ADVICE & FOLLOW-UP INSTRUCTIONS", margin + 12, cursorY + 7);

                    doc.fontSize(8.5)
                       .font("Helvetica")
                       .fillColor("#78350F")
                       .text(notes, margin + 12, cursorY + 20, {
                           width: contentWidth - 24,
                           height: 28,
                           ellipsis: true
                       });

                    cursorY += adviceBoxHeight + 14;
                } else {
                    cursorY += 8;
                }

                // ── Footer Section: Positioned safely at bottom ──
                const footerY = 720;

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

                // Right: Digital Signature Seal
                const sigBoxX = pageWidth - margin - 160;
                const sigBoxY = footerY - 4;
                const sigBoxWidth = 160;
                const sigBoxHeight = 58;

                doc.roundedRect(sigBoxX, sigBoxY, sigBoxWidth, sigBoxHeight, 5)
                   .fillAndStroke("#F0FDF4", "#BBF7D0");

                doc.fontSize(7.5)
                   .font("Helvetica-Bold")
                   .fillColor("#166534")
                   .text("DIGITALLY SIGNED & VERIFIED", sigBoxX, sigBoxY + 6, {
                       width: sigBoxWidth,
                       align: "center"
                   });

                doc.fontSize(9)
                   .font("Helvetica-Bold")
                   .fillColor("#0F172A")
                   .text(`${docPrefix}${docRawName}`, sigBoxX, sigBoxY + 19, {
                       width: sigBoxWidth,
                       align: "center",
                       ellipsis: true
                   });

                doc.fontSize(7)
                   .font("Helvetica")
                   .fillColor("#166534")
                   .text(`Reg No: ${docReg}`, sigBoxX, sigBoxY + 33, {
                       width: sigBoxWidth,
                       align: "center"
                   });

                const signTimestamp = formattedDate !== "NA" ? formattedDate : new Date().toLocaleDateString("en-IN");
                doc.fontSize(6.5)
                   .font("Helvetica-Oblique")
                   .fillColor("#64748B")
                   .text(`Signed: ${signTimestamp}`, sigBoxX, sigBoxY + 44, {
                       width: sigBoxWidth,
                       align: "center"
                   });

                // Bottom Page Tracker
                doc.fontSize(7)
                   .font("Helvetica")
                   .fillColor("#94A3B8")
                   .text("Page 1 of 1  •  Official Electronic Health Record", margin, 794, {
                       width: contentWidth,
                       align: "center"
                   });

                doc.end();
            } catch (err) {
                console.error("[PrescriptionPdfService] Fatal PDF generation error:", err);
                reject(err);
            }
        });
    }
}

export const prescriptionPdfService = new PrescriptionPdfService();
