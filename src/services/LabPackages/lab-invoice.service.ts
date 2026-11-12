import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { AppDataSource } from "../../config/database.js";
import { LabPackageOrder } from "../../models/LabPackages/lab-package-order.model.js";
import { LabPackagePayment } from "../../models/LabPackages/lab-package-payment.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { User } from "../../models/Account/user.model.js";

/** Orders past payment: these have an invoice. */
export const INVOICED_STATUSES = ["Paid", "SampleCollected", "ReportReady", "Completed"];

const FONT_DIR = path.resolve(process.cwd(), "public/fonts");
const money = (n: unknown) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const istDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const istTime = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

export interface LabInvoiceData {
    invoiceNumber: string;
    invoiceDate: Date;
    order: Pick<LabPackageOrder, "OrderNumber" | "PackageName" | "Price" | "GstPercentage" | "GstAmount" | "TotalAmount" | "TestsIncluded" | "CollectionAddress">;
    hospital: { name: string; address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; phone?: string | null; email?: string | null; gstin?: string | null };
    patient: { name: string; phone?: string | null; email?: string | null };
    payment: { method?: string | null; reference?: string | null; paidAt?: Date | null };
}

/** "INV-LPO-261112-A1B2C3": one invoice per order, so the order number keeps it unique. */
export const invoiceNumberFor = (orderNumber: string) => `INV-${orderNumber}`;

function testNames(json?: string | null): string[] {
    try {
        const v = JSON.parse(json || "[]");
        return Array.isArray(v) ? v.map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean).map(String) : [];
    } catch {
        return [];
    }
}

/** A one-page GST tax invoice for a lab package order. */
export function renderLabInvoicePdf(data: LabInvoiceData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 44, info: { Title: `Invoice ${data.invoiceNumber}`, Author: data.hospital.name } });
        const chunks: Buffer[] = [];
        doc.on("data", (c: Buffer) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const regular = path.join(FONT_DIR, "Poppins-Regular.ttf");
        const bold = path.join(FONT_DIR, "Poppins-SemiBold.ttf");
        const hasFonts = fs.existsSync(regular) && fs.existsSync(bold);
        if (hasFonts) {
            doc.registerFont("R", regular);
            doc.registerFont("B", bold);
        }
        const R = hasFonts ? "R" : "Helvetica";
        const B = hasFonts ? "B" : "Helvetica-Bold";
        const cash = (n: unknown) => (hasFonts ? money(n) : money(n).replace("₹", "Rs. "));

        const left = 44;
        const width = doc.page.width - 88;
        const blue = "#2563EB";
        const ink = "#111827";
        const muted = "#6B7280";
        const line = "#E5E7EB";

        doc.rect(0, 0, doc.page.width, 6).fill(blue);

        // Seller
        let y = 34;
        doc.font(B).fontSize(16).fillColor(ink).text(data.hospital.name, left, y, { width: width - 180 });
        const addr = [data.hospital.address, data.hospital.city, data.hospital.state, data.hospital.pincode].filter(Boolean).join(", ");
        doc.font(R).fontSize(8.5).fillColor(muted);
        if (addr) doc.text(addr, { width: width - 180 });
        const contact = [data.hospital.phone && `Ph: ${data.hospital.phone}`, data.hospital.email].filter(Boolean).join("  |  ");
        if (contact) doc.text(contact, { width: width - 180 });
        if (data.hospital.gstin) doc.font(B).fillColor(ink).text(`GSTIN: ${data.hospital.gstin}`, { width: width - 180 });
        const sellerBottom = doc.y;

        doc.font(B).fontSize(17).fillColor(blue).text("TAX INVOICE", left + width - 220, 34, { width: 220, align: "right", lineBreak: false });
        doc.font(R).fontSize(8.5).fillColor(muted)
            .text(`Invoice No: ${data.invoiceNumber}`, left + width - 200, 62, { width: 200, align: "right" })
            .text(`Date: ${istDate(data.invoiceDate)}`, { width: 200, align: "right" })
            .text(`Order No: ${data.order.OrderNumber}`, { width: 200, align: "right" });
        y = Math.max(sellerBottom, doc.y) + 16;
        doc.moveTo(left, y).lineTo(left + width, y).strokeColor(line).lineWidth(1).stroke();

        // Bill to / sample collection
        y += 12;
        doc.font(B).fontSize(8).fillColor(blue).text("BILLED TO", left, y);
        doc.font(B).fontSize(11).fillColor(ink).text(data.patient.name, left, doc.y + 2, { width: width / 2 - 10 });
        doc.font(R).fontSize(8.5).fillColor(muted);
        if (data.patient.phone) doc.text(`Ph: ${data.patient.phone}`, { width: width / 2 - 10 });
        if (data.patient.email) doc.text(data.patient.email, { width: width / 2 - 10 });
        const billBottom = doc.y;

        let collection = "";
        try {
            const a = JSON.parse(data.order.CollectionAddress || "null");
            if (a) collection = [a.line1 || a.addressLine1 || a.address, a.line2 || a.addressLine2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).join(", ");
        } catch {
            collection = String(data.order.CollectionAddress || "");
        }
        if (collection) {
            doc.font(B).fontSize(8).fillColor(blue).text("SAMPLE COLLECTION", left + width / 2 + 10, y);
            doc.font(R).fontSize(8.5).fillColor(ink).text(collection, left + width / 2 + 10, doc.y + 2, { width: width / 2 - 10 });
        }
        y = Math.max(billBottom, doc.y) + 18;

        // Items
        const cols = [
            { title: "#", x: left + 8, w: 20, align: "left" as const },
            { title: "Description", x: left + 30, w: width - 330, align: "left" as const },
            { title: "Qty", x: left + width - 296, w: 30, align: "right" as const },
            { title: "Rate", x: left + width - 258, w: 70, align: "right" as const },
            { title: `GST ${Number(data.order.GstPercentage || 0)}%`, x: left + width - 180, w: 80, align: "right" as const },
            { title: "Amount", x: left + width - 92, w: 84, align: "right" as const },
        ];
        doc.roundedRect(left, y, width, 24, 4).fill("#EFF4FF");
        doc.font(B).fontSize(8.5).fillColor(blue);
        for (const c of cols) doc.text(c.title, c.x, y + 7, { width: c.w, align: c.align });
        y += 30;

        const tests = testNames(data.order.TestsIncluded);
        const description = `${data.order.PackageName} (lab package)`;
        doc.font(B).fontSize(9.5).fillColor(ink).text(description, cols[1].x, y, { width: cols[1].w });
        let rowBottom = doc.y;
        if (tests.length) {
            doc.font(R).fontSize(8).fillColor(muted).text(`Includes: ${tests.join(", ")}`, cols[1].x, rowBottom + 2, { width: cols[1].w });
            rowBottom = doc.y;
        }
        doc.font(R).fontSize(9.5).fillColor(ink);
        doc.text("1", cols[0].x, y, { width: cols[0].w });
        doc.text("1", cols[2].x, y, { width: cols[2].w, align: "right" });
        doc.text(cash(data.order.Price), cols[3].x, y, { width: cols[3].w, align: "right" });
        doc.text(cash(data.order.GstAmount), cols[4].x, y, { width: cols[4].w, align: "right" });
        doc.text(cash(data.order.TotalAmount), cols[5].x, y, { width: cols[5].w, align: "right" });
        y = rowBottom + 12;
        doc.moveTo(left, y).lineTo(left + width, y).strokeColor(line).stroke();

        // Totals
        y += 10;
        const gst = Number(data.order.GstAmount || 0);
        const rows: [string, string, boolean?][] = [
            ["Taxable value", cash(data.order.Price)],
            [`CGST (${Number(data.order.GstPercentage || 0) / 2}%)`, cash(gst / 2)],
            [`SGST (${Number(data.order.GstPercentage || 0) / 2}%)`, cash(gst / 2)],
            ["Total", cash(data.order.TotalAmount), true],
            ["Paid", cash(data.order.TotalAmount)],
            ["Balance due", cash(0)],
        ];
        for (const [label, value, strong] of rows) {
            doc.font(strong ? B : R).fontSize(strong ? 11 : 9).fillColor(strong ? ink : muted).text(label, left + width - 260, y, { width: 160, align: "right" });
            doc.font(strong ? B : R).fontSize(strong ? 11 : 9).fillColor(ink).text(value, left + width - 92, y, { width: 84, align: "right" });
            y += strong ? 20 : 15;
        }

        // Payment
        y += 10;
        doc.roundedRect(left, y, width, 48, 6).fill("#F0FDF4");
        doc.font(B).fontSize(9).fillColor("#166534").text("PAID", left + 14, y + 9);
        const paidAt = data.payment.paidAt ? `${istDate(data.payment.paidAt)}, ${istTime(data.payment.paidAt)}` : istDate(data.invoiceDate);
        const via = [data.payment.method ? `via ${data.payment.method}` : (Number(data.order.TotalAmount) > 0 ? "online" : "no payment needed"), data.payment.reference ? `Ref ${data.payment.reference}` : ""].filter(Boolean).join("  |  ");
        doc.font(R).fontSize(8.5).fillColor("#166534").text(`${cash(data.order.TotalAmount)} on ${paidAt}${via ? `  |  ${via}` : ""}`, left + 14, y + 25, { width: width - 28 });

        // Footer
        // Inside the bottom margin, so pdfkit never starts a second page for the footer
        const footY = doc.page.height - 44 - 36;
        doc.moveTo(left, footY).lineTo(left + width, footY).strokeColor(line).stroke();
        doc.font(R).fontSize(7.5).fillColor(muted)
            .text("This is a computer-generated invoice and needs no signature. Prices include GST as shown.", left, footY + 6, { width, lineBreak: false })
            .text(`Booked through Yira Health · ${data.hospital.name}`, left, footY + 18, { width, lineBreak: false });
        doc.end();
    });
}

export class LabInvoiceService {
    private orders = AppDataSource.getRepository(LabPackageOrder);

    /**
     * The order's invoice, created the first time it is asked for once the order is paid. Never
     * throws for the caller's sake: a failed invoice must not undo a payment; the next call retries.
     */
    async ensureInvoice(orderId: string): Promise<{ invoiceNumber: string; invoiceUrl: string } | null> {
        try {
            const order = await this.orders.findOne({ where: { Id: orderId } });
            if (!order || !INVOICED_STATUSES.includes(order.Status)) return null;
            if (order.InvoiceUrl && order.InvoiceNumber) return { invoiceNumber: order.InvoiceNumber, invoiceUrl: order.InvoiceUrl };

            const [hospital, config, patient, payment] = await Promise.all([
                AppDataSource.getRepository(Hospital).findOne({ where: { Id: order.HospitalId } }),
                AppDataSource.getRepository(HospitalPaymentConfiguration).findOne({ where: { HospitalId: order.HospitalId } as any }),
                AppDataSource.getRepository(User).findOne({ where: { Id: order.PatientId }, select: { Id: true, FirstName: true, LastName: true, PhoneNumber: true, Email: true } }),
                AppDataSource.getRepository(LabPackagePayment).findOne({ where: { LabPackageOrderId: order.Id, Status: "Success" }, order: { UpdatedAt: "DESC" } }),
            ]);
            const invoiceNumber = invoiceNumberFor(order.OrderNumber);
            const invoiceDate = new Date();
            const h = hospital as any;
            const pdf = await renderLabInvoicePdf({
                invoiceNumber,
                invoiceDate,
                order,
                hospital: {
                    name: h?.Name || "Yira Hospitals",
                    address: h?.Address, city: h?.City, state: h?.State, pincode: h?.Pincode,
                    phone: h?.HelplineNumber || h?.MobileNumber, email: h?.Email,
                    gstin: (config as any)?.GstNumber || null,
                },
                patient: {
                    name: [patient?.FirstName, patient?.LastName].filter(Boolean).join(" ").trim() || "Patient",
                    phone: patient?.PhoneNumber, email: patient?.Email,
                },
                payment: { method: payment?.Method || (payment ? "Razorpay" : null), reference: payment?.GatewayPaymentId || null, paidAt: payment?.UpdatedAt || null },
            });

            const { BlobService } = await import("../Common/blob.service.js");
            const url = await new BlobService().uploadBuffer(pdf, `lab-invoices/${order.HospitalId}/${invoiceNumber}.pdf`, "application/pdf");
            // Only the first writer sets it, so two requests at once can't leave two numbers.
            await this.orders.createQueryBuilder().update(LabPackageOrder)
                .set({ InvoiceNumber: invoiceNumber, InvoiceUrl: url, InvoicedAt: invoiceDate })
                .where("Id = :id AND InvoiceUrl IS NULL", { id: order.Id })
                .execute();
            const saved = await this.orders.findOne({ where: { Id: order.Id }, select: { Id: true, InvoiceNumber: true, InvoiceUrl: true } });
            return saved?.InvoiceUrl ? { invoiceNumber: saved.InvoiceNumber!, invoiceUrl: saved.InvoiceUrl } : null;
        } catch (e: any) {
            console.error(`[LabInvoice] Could not create the invoice for order ${orderId}:`, e?.message || e);
            return null;
        }
    }

    /** Creates any missing invoices for these orders (a few at a time), e.g. for orders paid before invoices existed. */
    async ensureInvoices(orderIds: string[]): Promise<void> {
        for (let i = 0; i < orderIds.length; i += 4) {
            await Promise.all(orderIds.slice(i, i + 4).map((id) => this.ensureInvoice(id)));
        }
    }
}

export const labInvoiceService = new LabInvoiceService();
