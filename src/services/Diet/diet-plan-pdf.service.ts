import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import axios from "axios";
import { keepUnits, pdfText } from "../../utils/pdf-text.js";

// Text cleaning is shared with the prescription PDF.
export { pdfText };

export interface DietPlanPdfMeal {
    dayNumber: number;
    slot: string;
    time?: string;
    food: string;
    portion: string;
    calories: number;
    /** True when the calories were worked out from the macros or the food, not entered. */
    estimated?: boolean;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
    notes?: string;
}

export interface DietPlanPdfInput {
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
        registrationNumber?: string;
    };
    patient: {
        name?: string;
        patientId?: string;
        age?: string | number;
        gender?: string;
        phoneNumber?: string;
        bloodGroup?: string;
    };
    plan: {
        id: number;
        name: string;
        condition?: string;
        description?: string;
        dietType?: string;
        /** "YYYY-MM-DD" */
        prescribedOn?: string;
        startDate?: string;
        endDate?: string;
        totalDays: number;
        targets: { calories?: number; proteinG?: number; carbsG?: number; fatG?: number };
        foodsToPrefer: string[];
        foodsToAvoid: string[];
        doctorNotes?: string;
        meals: DietPlanPdfMeal[];
    };
}

const NAVY = "#1E3A8A";
const SKY = "#0284C7";
const INK = "#0F172A";
const BODY = "#334155";
const MUTED = "#64748B";
const FAINT = "#94A3B8";
const LINE = "#E2E8F0";

const PAGE_WIDTH = 595.28;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
/** Content stops here; the page number sits below it. */
const FLOW_BOTTOM = 780;
/** Text past this line would make PDFKit start a new page on its own. */
const PAGE_BOTTOM = 841.89 - 30;
const PAGE_TOP = 36;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "11 Nov 2026" from "2026-11-11". */
export function pdfDate(value?: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
    if (!match) return "";
    return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

const minutesOf = (time?: string) => {
    const match = /^(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?$/.exec((time ?? "").trim());
    if (!match) return 24 * 60;
    let hour = Number(match[1]);
    const period = match[3]?.toUpperCase();
    if (period === "PM" && hour < 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + Number(match[2]);
};

const num = (value: number) => (Number.isInteger(value) ? value.toLocaleString("en-IN") : (Math.round(value * 10) / 10).toLocaleString("en-IN"));
const grams = (value?: number) => (value !== undefined && value !== null && value > 0 ? `${num(value)} g` : "-");
const hasValue = (value?: number) => value !== undefined && value !== null && value > 0;

function isValidImageBuffer(buf: Buffer): boolean {
    if (!buf || buf.length < 4) return false;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return isPng || isJpg;
}

async function loadLogo(url?: string): Promise<Buffer | null> {
    if (url && url.startsWith("http")) {
        try {
            const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 4000 });
            const candidate = Buffer.from(resp.data);
            if (isValidImageBuffer(candidate)) return candidate;
        } catch {
            // No logo is fine; the fallback below is used.
        }
    }
    const fallbackPath = path.resolve(process.cwd(), "public/images/hospital_logo.png");
    if (fs.existsSync(fallbackPath)) {
        const local = fs.readFileSync(fallbackPath);
        if (isValidImageBuffer(local)) return local;
    }
    return null;
}

/** One instruction per line, with the separators doctors type between lines tidied away. */
function adviceLines(notes?: string): string[] {
    return (notes ?? "")
        .split(/\r?\n/)
        .map((line) => pdfText(line).replace(/^[\s,;.•]+|[\s,;]+$/g, ""))
        .filter((line) => line.length > 0);
}

type Slot = { name: string; time: string; items: DietPlanPdfMeal[] };

function slotsOfDay(meals: DietPlanPdfMeal[], day: number): Slot[] {
    const slots = new Map<string, Slot>();
    meals
        .filter((m) => m.dayNumber === day)
        .forEach((meal) => {
            const key = pdfText(meal.slot).toLowerCase() || "meal";
            const slot = slots.get(key) ?? { name: pdfText(meal.slot) || "Meal", time: pdfText(meal.time), items: [] };
            slot.items.push(meal);
            slots.set(key, slot);
        });
    return [...slots.values()].sort((a, b) => minutesOf(a.time) - minutesOf(b.time));
}

export class DietPlanPdfService {
    /** A printable diet plan: the hospital header, patient and doctor, targets, the menu for each day and the doctor's guidance. */
    async generateDietPlanPdf(data: DietPlanPdfInput): Promise<Buffer> {
        const logo = await loadLogo(data.hospital.logoUrl);
        const patientName = pdfText(data.patient.name) || "Patient";
        const planName = pdfText(data.plan.name) || "Diet Plan";
        const rawDoctor = pdfText(data.doctor.name);
        const doctorName = rawDoctor ? (rawDoctor.toLowerCase().startsWith("dr") ? rawDoctor : `Dr. ${rawDoctor}`) : "NA";

        return new Promise<Buffer>((resolve, reject) => {
            try {
                const doc = new PDFDocument({
                    size: "A4",
                    margins: { top: 30, bottom: 30, left: MARGIN, right: MARGIN },
                    bufferPages: true,
                    info: {
                        Title: `Diet Plan - ${planName} - ${patientName}`,
                        Author: doctorName,
                        Subject: `Diet plan ${data.plan.id}`,
                        Creator: "ClinX Health Systems",
                    },
                });
                const chunks: Buffer[] = [];
                doc.on("data", (chunk: Buffer) => chunks.push(chunk));
                doc.on("end", () => resolve(Buffer.concat(chunks)));
                doc.on("error", reject);

                let y = 22;
                const newPage = () => {
                    doc.addPage();
                    y = PAGE_TOP;
                };
                const ensureRoom = (needed: number) => {
                    if (y + needed > FLOW_BOTTOM) newPage();
                };
                // Text is never cut short: every block wraps, and boxes grow to fit what is in them.
                type Line = { text: string; font: string; size: number; color: string; gap?: number; align?: "left" | "center" | "right" };
                const stackHeight = (lines: Line[], width: number) =>
                    lines.reduce((h, l) => {
                        doc.font(l.font).fontSize(l.size);
                        return h + (l.gap ?? 0) + doc.heightOfString(l.text, { width });
                    }, 0);
                const drawStack = (lines: Line[], x: number, top: number, width: number) => {
                    let cy = top;
                    for (const l of lines) {
                        cy += l.gap ?? 0;
                        doc.font(l.font).fontSize(l.size).fillColor(l.color).text(l.text, x, cy, { width, align: l.align ?? "left" });
                        cy = doc.y;
                    }
                    return cy;
                };

                // ── Hospital header ──
                doc.rect(0, 0, PAGE_WIDTH, 5).fill(NAVY);
                if (logo) {
                    try {
                        doc.image(logo, MARGIN, y, { fit: [56, 56] });
                    } catch (error) {
                        console.warn("[DietPlanPdf] Could not draw the logo:", error);
                    }
                }
                const badgeWidth = 100;
                const headerX = MARGIN + 66;
                const headerWidth = CONTENT_WIDTH - 66 - badgeWidth - 8;
                const state = pdfText(data.hospital.state);
                const pincode = pdfText(data.hospital.pincode);
                const address = [pdfText(data.hospital.address), pdfText(data.hospital.city), state ? `${state}${pincode ? ` - ${pincode}` : ""}` : pincode]
                    .filter(Boolean)
                    .join(", ");
                const contact = [
                    `Ph: ${pdfText(data.hospital.helpline) || "NA"}`,
                    `Email: ${pdfText(data.hospital.email) || "NA"}`,
                    `Web: ${pdfText(data.hospital.website) || "NA"}`,
                ].join("  |  ");
                const headerBottom = drawStack([
                    { text: pdfText(data.hospital.name) || "NA", font: "Helvetica-Bold", size: 15, color: NAVY },
                    { text: address || "Address: NA", font: "Helvetica", size: 8, color: "#475569", gap: 4 },
                    { text: contact, font: "Helvetica", size: 7.5, color: MUTED, gap: 3 },
                ], headerX, y + 2, headerWidth);

                const badgeX = PAGE_WIDTH - MARGIN - badgeWidth;
                doc.roundedRect(badgeX, y + 8, badgeWidth, 22, 4).fillAndStroke("#EFF6FF", "#BFDBFE");
                doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#1E40AF")
                    .text("DIET PLAN", badgeX, y + 15, { width: badgeWidth, align: "center", lineBreak: false });

                // The divider sits under the logo, or under the hospital's details when they run longer.
                y = Math.max(86, Math.ceil(headerBottom) + 8);
                doc.rect(MARGIN, y, CONTENT_WIDTH, 1.5).fill(SKY);
                doc.rect(MARGIN, y + 1.5, CONTENT_WIDTH, 0.5).fill(LINE);

                // ── Reference bar ──
                y += 8;
                doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 22, 4).fillAndStroke("#F0F9FF", "#E0F2FE");
                const start = pdfDate(data.plan.startDate);
                const end = pdfDate(data.plan.endDate);
                const validity = start ? (end ? `Valid: ${start} to ${end}` : `From ${start}, no end date`) : "";
                doc.font("Helvetica-Bold").fontSize(8.5).fillColor(NAVY).text(`Plan No: ${data.plan.id}`, MARGIN + 10, y + 7, { lineBreak: false });
                doc.font("Helvetica").fontSize(8).fillColor(BODY)
                    .text(`Prescribed: ${pdfDate(data.plan.prescribedOn) || "NA"}`, MARGIN + 130, y + 7, { lineBreak: false });
                doc.font("Helvetica-Bold").fontSize(8).fillColor(SKY)
                    .text(validity, MARGIN + 270, y + 7, { width: CONTENT_WIDTH - 280, align: "right", lineBreak: false });

                // ── Patient and doctor ──
                y += 30;
                const half = CONTENT_WIDTH / 2;
                const colWidth = half - 24;
                const qual = pdfText(data.doctor.qualification) || "NA";
                const spec = pdfText(data.doctor.specialty) || "NA";
                const reg = pdfText(data.doctor.registrationNumber) || "NA";
                const age = data.patient.age !== undefined && data.patient.age !== null && String(data.patient.age).trim() !== "" ? `${data.patient.age} Yrs` : "NA";
                const rawPatientId = pdfText(data.patient.patientId);
                const patientId = !rawPatientId || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rawPatientId) ? "NA" : rawPatientId;
                const patientLines: Line[] = [
                    { text: "PATIENT", font: "Helvetica-Bold", size: 7.5, color: SKY },
                    { text: patientName, font: "Helvetica-Bold", size: 10, color: INK, gap: 4 },
                    { text: `Age: ${age}  |  Gender: ${pdfText(data.patient.gender) || "NA"}  |  Blood: ${pdfText(data.patient.bloodGroup) || "NA"}`, font: "Helvetica", size: 8, color: BODY, gap: 3 },
                    { text: `Patient ID: ${patientId}  |  Ph: ${pdfText(data.patient.phoneNumber) || "NA"}`, font: "Helvetica", size: 8, color: MUTED, gap: 2 },
                ];
                const doctorLines: Line[] = [
                    { text: "PRESCRIBED BY", font: "Helvetica-Bold", size: 7.5, color: SKY },
                    { text: doctorName, font: "Helvetica-Bold", size: 10, color: INK, gap: 4 },
                    { text: `Qual: ${qual}`, font: "Helvetica", size: 8, color: BODY, gap: 3 },
                    { text: `Dept: ${spec}`, font: "Helvetica", size: 8, color: BODY, gap: 2 },
                    { text: `Reg No: ${reg}`, font: "Helvetica-Bold", size: 8, color: "#1E40AF", gap: 3 },
                ];
                const cardHeight = Math.max(72, Math.ceil(8 + Math.max(stackHeight(patientLines, colWidth), stackHeight(doctorLines, colWidth)) + 10));
                ensureRoom(cardHeight);
                doc.roundedRect(MARGIN, y, CONTENT_WIDTH, cardHeight, 6).fillAndStroke("#F8FAFC", LINE);
                doc.moveTo(MARGIN + half, y + 6).lineTo(MARGIN + half, y + cardHeight - 6).strokeColor(LINE).lineWidth(1).stroke();
                drawStack(patientLines, MARGIN + 12, y + 8, colWidth);
                drawStack(doctorLines, MARGIN + half + 14, y + 8, colWidth);
                y += cardHeight + 14;

                // ── The plan ──
                doc.font("Helvetica-Bold").fontSize(13);
                ensureRoom(doc.heightOfString(planName, { width: CONTENT_WIDTH }) + 40);
                doc.fillColor(NAVY).text(planName, MARGIN, y, { width: CONTENT_WIDTH });
                y = doc.y + 3;
                const totalDays = Math.max(1, Math.trunc(data.plan.totalDays) || 1);
                const facts = [
                    pdfText(data.plan.condition) ? `Goal / condition: ${pdfText(data.plan.condition)}` : "",
                    `Diet type: ${pdfText(data.plan.dietType) || "Veg"}`,
                    totalDays > 1 ? `${totalDays}-day menu that repeats` : "Same menu every day",
                ].filter(Boolean);
                doc.font("Helvetica").fontSize(8.5).fillColor(BODY).text(facts.join("   |   "), MARGIN, y, { width: CONTENT_WIDTH });
                y = doc.y + 2;
                const description = pdfText(data.plan.description);
                if (description) {
                    doc.fontSize(8.5).fillColor(MUTED).text(description, MARGIN, y + 2, { width: CONTENT_WIDTH });
                    y = doc.y + 2;
                }

                // ── Daily targets ──
                const t = data.plan.targets;
                const tiles = [
                    { label: "CALORIES", value: hasValue(t.calories) ? `${num(Math.round(t.calories!))} kcal` : "" },
                    { label: "PROTEIN", value: hasValue(t.proteinG) ? `${num(t.proteinG!)} g` : "" },
                    { label: "CARBS", value: hasValue(t.carbsG) ? `${num(t.carbsG!)} g` : "" },
                    { label: "FAT", value: hasValue(t.fatG) ? `${num(t.fatG!)} g` : "" },
                ].filter((tile) => tile.value);
                if (tiles.length) {
                    y += 8;
                    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text("DAILY TARGETS", MARGIN, y, { lineBreak: false });
                    y += 11;
                    const tileWidth = (CONTENT_WIDTH - 3 * 8) / 4;
                    tiles.forEach((tile, i) => {
                        const x = MARGIN + i * (tileWidth + 8);
                        doc.roundedRect(x, y, tileWidth, 34, 5).fillAndStroke("#F8FAFC", LINE);
                        doc.font("Helvetica-Bold").fontSize(7).fillColor(MUTED).text(tile.label, x + 10, y + 7, { lineBreak: false });
                        doc.fontSize(11.5).fillColor(INK).text(tile.value, x + 10, y + 17, { width: tileWidth - 20, lineBreak: false });
                    });
                    y += 34;
                }

                // ── Menu ──
                y += 16;
                ensureRoom(90);
                doc.font("Helvetica-Bold").fontSize(10.5).fillColor(NAVY).text("MEAL PLAN", MARGIN, y, { lineBreak: false });
                doc.rect(MARGIN, y + 14, 64, 1.5).fill(NAVY);
                y += 20;
                const anyEstimated = data.plan.meals.some((m) => m.estimated && m.calories > 0);
                doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(
                    (totalDays > 1
                        ? `Follow Day 1 to Day ${totalDays} in order, then start again from Day 1.`
                        : "Follow these meals every day.")
                        + (anyEstimated ? "  ~ marks calories worked out from the food's protein, carbs and fat." : ""),
                    MARGIN, y, { width: CONTENT_WIDTH },
                );
                y = doc.y + 8;

                const cols = [
                    // Number columns are wide enough for a day's totals in the thousands ("1,107.9 g").
                    { key: "meal", title: "MEAL / TIME", width: 88 },
                    { key: "food", title: "FOOD", width: 160 },
                    { key: "portion", title: "PORTION", width: 87 },
                    { key: "kcal", title: "KCAL", width: 46, align: "right" as const },
                    { key: "p", title: "PROTEIN", width: 48, align: "right" as const },
                    { key: "c", title: "CARBS", width: 48, align: "right" as const },
                    { key: "f", title: "FAT", width: CONTENT_WIDTH - (88 + 160 + 87 + 46 + 48 + 48), align: "right" as const },
                ];
                const colX: Record<string, number> = {};
                cols.reduce((x, col) => {
                    colX[col.key] = x;
                    return x + col.width;
                }, MARGIN);
                const widthOf = (key: string) => cols.find((c) => c.key === key)!.width;

                const tableHeader = () => {
                    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 18, 4).fill(NAVY);
                    doc.font("Helvetica-Bold").fontSize(7).fillColor("#FFFFFF");
                    cols.forEach((col) => {
                        // Lined up with the cells below: left text starts 6pt in, right-aligned numbers end 6pt in.
                        doc.text(col.title, colX[col.key] + (col.align ? 2 : 6), y + 6, { width: col.width - (col.align ? 8 : 12), align: col.align ?? "left", lineBreak: false });
                    });
                    y += 18;
                };
                const totalsText = (items: DietPlanPdfMeal[]) => {
                    const sum = (pick: (m: DietPlanPdfMeal) => number | undefined) => items.reduce((total, m) => total + (pick(m) ?? 0), 0);
                    return { kcal: sum((m) => m.calories), p: sum((m) => m.proteinG), c: sum((m) => m.carbsG), f: sum((m) => m.fatG) };
                };

                for (let day = 1; day <= totalDays; day++) {
                    const slots = slotsOfDay(data.plan.meals, day);
                    const dayItems = slots.flatMap((s) => s.items);
                    const dayLabel = totalDays > 1 ? `DAY ${day}` : "EVERY DAY";
                    ensureRoom(22 + 18 + 30);
                    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 20, 4).fillAndStroke("#F0F9FF", "#E0F2FE");
                    doc.font("Helvetica-Bold").fontSize(9).fillColor(NAVY).text(dayLabel, MARGIN + 10, y + 6, { lineBreak: false });
                    if (dayItems.length) {
                        const sums = totalsText(dayItems);
                        doc.font("Helvetica").fontSize(8).fillColor(BODY).text(
                            `${num(Math.round(sums.kcal))} kcal  |  Protein ${grams(sums.p)}  |  Carbs ${grams(sums.c)}  |  Fat ${grams(sums.f)}`,
                            MARGIN + 120, y + 6, { width: CONTENT_WIDTH - 130, align: "right", lineBreak: false },
                        );
                    }
                    y += 22;

                    if (!dayItems.length) {
                        doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED).text("No meals planned for this day.", MARGIN + 10, y + 4, { lineBreak: false });
                        y += 22;
                        continue;
                    }

                    tableHeader();
                    slots.forEach((slot, slotIndex) => {
                        let slotLabelShown = false;
                        slot.items.forEach((item, itemIndex) => {
                            const food = keepUnits(pdfText(item.food) || "NA");
                            const notes = keepUnits(pdfText(item.notes));
                            const portion = keepUnits(pdfText(item.portion) || "-");
                            doc.font("Helvetica-Bold").fontSize(8.5);
                            const foodHeight = doc.heightOfString(food, { width: widthOf("food") - 12 });
                            doc.font("Helvetica-Oblique").fontSize(7.5);
                            const notesHeight = notes ? doc.heightOfString(notes, { width: widthOf("food") - 12 }) + 2 : 0;
                            doc.font("Helvetica").fontSize(8);
                            const portionHeight = doc.heightOfString(portion, { width: widthOf("portion") - 12 });
                            const slotLines: Line[] = [
                                { text: slot.name, font: "Helvetica-Bold", size: 8.5, color: INK },
                                ...(slot.time ? [{ text: slot.time, font: "Helvetica", size: 7.5, color: MUTED, gap: 1 }] : []),
                            ];
                            const rowHeightFor = (withSlot: boolean) =>
                                Math.ceil(Math.max(22, foodHeight + notesHeight + 12, portionHeight + 12, withSlot ? stackHeight(slotLines, widthOf("meal") - 12) + 12 : 0));
                            let rowHeight = rowHeightFor(!slotLabelShown);

                            if (y + rowHeight > FLOW_BOTTOM) {
                                newPage();
                                // The meal's name is shown again at the top of the new page.
                                doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(`${totalDays > 1 ? `Day ${day}` : "Every day"} (continued)`, MARGIN, y, { lineBreak: false });
                                y += 13;
                                tableHeader();
                                slotLabelShown = false;
                                rowHeight = rowHeightFor(true);
                            }

                            doc.rect(MARGIN, y, CONTENT_WIDTH, rowHeight).fill(slotIndex % 2 === 0 ? "#FFFFFF" : "#F8FAFC");
                            const lastInSlot = itemIndex === slot.items.length - 1;
                            doc.moveTo(lastInSlot ? MARGIN : colX.food, y + rowHeight).lineTo(MARGIN + CONTENT_WIDTH, y + rowHeight)
                                .strokeColor(lastInSlot ? "#CBD5E1" : LINE).lineWidth(lastInSlot ? 0.75 : 0.5).stroke();

                            if (!slotLabelShown) {
                                drawStack(slotLines, colX.meal + 6, y + 6, widthOf("meal") - 12);
                                slotLabelShown = true;
                            }

                            doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(food, colX.food + 6, y + 6, { width: widthOf("food") - 12 });
                            if (notes) {
                                doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(MUTED).text(notes, colX.food + 6, y + 8 + foodHeight, { width: widthOf("food") - 12 });
                            }
                            doc.font("Helvetica").fontSize(8).fillColor(BODY).text(portion, colX.portion + 6, y + 6, { width: widthOf("portion") - 12 });
                            const kcal = item.calories > 0 ? `${item.estimated ? "~" : ""}${num(Math.round(item.calories))}` : "-";
                            doc.font("Helvetica-Bold").fillColor(INK).text(kcal, colX.kcal + 4, y + 6, { width: widthOf("kcal") - 10, align: "right", lineBreak: false });
                            doc.font("Helvetica").fillColor(BODY);
                            doc.text(grams(item.proteinG), colX.p + 2, y + 6, { width: widthOf("p") - 8, align: "right", lineBreak: false });
                            doc.text(grams(item.carbsG), colX.c + 2, y + 6, { width: widthOf("c") - 8, align: "right", lineBreak: false });
                            doc.text(grams(item.fatG), colX.f + 2, y + 6, { width: widthOf("f") - 8, align: "right", lineBreak: false });
                            y += rowHeight;
                        });
                    });

                    // Day total
                    if (y + 20 > FLOW_BOTTOM) newPage();
                    const sums = totalsText(dayItems);
                    doc.rect(MARGIN, y, CONTENT_WIDTH, 20).fill("#F1F5F9");
                    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK).text(totalDays > 1 ? `Day ${day} total` : "Daily total", colX.meal + 6, y + 6, { lineBreak: false });
                    if (hasValue(t.calories)) {
                        doc.font("Helvetica").fillColor(MUTED).text(`Target ${num(Math.round(t.calories!))} kcal`, colX.portion + 6, y + 6, { width: widthOf("portion") - 8, lineBreak: false });
                    }
                    doc.font("Helvetica-Bold").fillColor(INK).text(num(Math.round(sums.kcal)), colX.kcal + 4, y + 6, { width: widthOf("kcal") - 10, align: "right", lineBreak: false });
                    doc.text(grams(sums.p), colX.p + 2, y + 6, { width: widthOf("p") - 8, align: "right", lineBreak: false });
                    doc.text(grams(sums.c), colX.c + 2, y + 6, { width: widthOf("c") - 8, align: "right", lineBreak: false });
                    doc.text(grams(sums.f), colX.f + 2, y + 6, { width: widthOf("f") - 8, align: "right", lineBreak: false });
                    y += 20 + 12;
                }

                /**
                 * A titled box of paragraphs that grows to fit them and carries on to the next page
                 * when it doesn't fit, so nothing is ever cut.
                 */
                const flowBox = (title: string, paragraphs: string[], style: { fill: string; stroke: string; title: string; text: string; accent?: string }) => {
                    const width = CONTENT_WIDTH - 24;
                    doc.font("Helvetica").fontSize(8.5);
                    const heights = paragraphs.map((p) => doc.heightOfString(p, { width }) + 3);
                    let i = 0;
                    let first = true;
                    while (i < paragraphs.length) {
                        ensureRoom(21 + heights[i] + 8);
                        const top = y;
                        let h = 21;
                        let j = i;
                        while (j < paragraphs.length && (j === i || top + h + heights[j] + 5 <= FLOW_BOTTOM)) {
                            h += heights[j];
                            j++;
                        }
                        const boxHeight = Math.ceil(h + 5);
                        doc.roundedRect(MARGIN, top, CONTENT_WIDTH, boxHeight, 5).fillAndStroke(style.fill, style.stroke);
                        if (style.accent) doc.roundedRect(MARGIN, top, 4, boxHeight, 2).fill(style.accent);
                        doc.font("Helvetica-Bold").fontSize(8).fillColor(style.title).text(first ? title : `${title} (continued)`, MARGIN + 12, top + 8, { width });
                        let lineY = top + 21;
                        doc.font("Helvetica").fontSize(8.5).fillColor(style.text);
                        for (let k = i; k < j; k++) {
                            doc.text(paragraphs[k], MARGIN + 12, lineY, { width });
                            lineY += heights[k];
                        }
                        y = top + boxHeight + 12;
                        i = j;
                        first = false;
                    }
                };

                // ── Foods to prefer and avoid ──
                const prefer = data.plan.foodsToPrefer.map(pdfText).filter(Boolean);
                const avoid = data.plan.foodsToAvoid.map(pdfText).filter(Boolean);
                const lists = [
                    { title: "FOODS TO PREFER", items: prefer, fill: "#F0FDF4", stroke: "#BBF7D0", ink: "#166534" },
                    { title: "FOODS TO AVOID", items: avoid, fill: "#FEF2F2", stroke: "#FECACA", ink: "#991B1B" },
                ].filter((list) => list.items.length);
                if (lists.length) {
                    y += 6;
                    const boxWidth = lists.length === 2 ? (CONTENT_WIDTH - 10) / 2 : CONTENT_WIDTH;
                    const textOf = (items: string[]) => items.join("   \u2022   ");
                    doc.font("Helvetica").fontSize(8.5);
                    const boxHeight = Math.ceil(Math.max(...lists.map((list) => doc.heightOfString(textOf(list.items), { width: boxWidth - 24 }))) + 30);
                    if (boxHeight <= (FLOW_BOTTOM - PAGE_TOP) / 2) {
                        // Short lists sit side by side.
                        ensureRoom(boxHeight);
                        lists.forEach((list, i) => {
                            const x = MARGIN + i * (boxWidth + 10);
                            doc.roundedRect(x, y, boxWidth, boxHeight, 5).fillAndStroke(list.fill, list.stroke);
                            doc.font("Helvetica-Bold").fontSize(8).fillColor(list.ink).text(list.title, x + 12, y + 8, { width: boxWidth - 24 });
                            doc.font("Helvetica").fontSize(8.5).fillColor(BODY).text(textOf(list.items), x + 12, y + 21, { width: boxWidth - 24 });
                        });
                        y += boxHeight + 12;
                    } else {
                        // Long lists get the full width, one item per line, and may carry on to the next page.
                        for (const list of lists) {
                            flowBox(list.title, list.items.map((item) => `\u2022  ${item}`), { fill: list.fill, stroke: list.stroke, title: list.ink, text: BODY });
                        }
                    }
                }

                // ── Doctor's notes ──
                const advice = adviceLines(data.plan.doctorNotes);
                if (advice.length) {
                    y += 2;
                    flowBox("DOCTOR'S NOTES & ADVICE", advice, { fill: "#FFFBEB", stroke: "#FDE68A", title: "#92400E", text: "#78350F", accent: "#D97706" });
                }

                // ── Signature, at the foot of the last page ──
                const sigWidth = 160;
                const sigX = PAGE_WIDTH - MARGIN - sigWidth;
                const sigLines: Line[] = [
                    { text: "PRESCRIBED BY", font: "Helvetica-Bold", size: 7.5, color: "#166534", align: "center" },
                    { text: doctorName, font: "Helvetica-Bold", size: 9, color: INK, gap: 3, align: "center" },
                    { text: `Reg No: ${reg}`, font: "Helvetica", size: 7, color: "#166534", gap: 2, align: "center" },
                    { text: `Issued: ${pdfDate(data.plan.prescribedOn) || "NA"}`, font: "Helvetica-Oblique", size: 6.5, color: MUTED, gap: 2, align: "center" },
                ];
                const sigHeight = Math.max(56, Math.ceil(stackHeight(sigLines, sigWidth - 12) + 14));
                if (y + sigHeight + 10 > FLOW_BOTTOM) newPage();
                const footerY = FLOW_BOTTOM - sigHeight;
                doc.rect(MARGIN, footerY - 8, CONTENT_WIDTH, 0.75).fill("#CBD5E1");
                doc.font("Helvetica-Oblique").fontSize(7.5).fillColor(MUTED).text(
                    "Follow this plan as advised by your doctor. Check with them before changing it, and tell them about any food allergies or if you feel unwell.",
                    MARGIN, footerY + 12, { width: CONTENT_WIDTH - 190, lineGap: 3 },
                );
                doc.roundedRect(sigX, footerY, sigWidth, sigHeight, 5).fillAndStroke("#F0FDF4", "#BBF7D0");
                drawStack(sigLines, sigX + 6, footerY + 7, sigWidth - 12);

                // ── Page numbers ──
                const { start: first, count } = doc.bufferedPageRange();
                for (let i = 0; i < count; i++) {
                    doc.switchToPage(first + i);
                    const pageLine = `Page ${i + 1} of ${count}  |  Diet plan for ${patientName}  |  Official Electronic Health Record`;
                    doc.font("Helvetica").fontSize(7).fillColor(FAINT);
                    const pageLineY = Math.min(794, PAGE_BOTTOM - 2 - doc.heightOfString(pageLine, { width: CONTENT_WIDTH }));
                    doc.text(pageLine, MARGIN, pageLineY, { width: CONTENT_WIDTH, align: "center" });
                }
                doc.end();
            } catch (error) {
                console.error("[DietPlanPdf] Could not build the PDF:", error);
                reject(error);
            }
        });
    }
}

export const dietPlanPdfService = new DietPlanPdfService();
