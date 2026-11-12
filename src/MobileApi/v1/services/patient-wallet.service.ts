import { In } from "typeorm/index.js";
import { AppDataSource } from "../../../config/database.js";
import { PatientManualBill } from "../../../models/Wallet/patient-manual-bill.model.js";
import { PatientPolicy } from "../../../models/Wallet/patient-policy.model.js";

export const BILL_CATEGORIES = ["Consultation", "Pharmacy", "Lab tests", "Hospital stay", "Procedure", "Other"] as const;
export const POLICY_TYPES = ["Health", "Life", "Accident", "Critical illness", "Government scheme", "Other"] as const;
export const PAYMENT_MODES = ["Cash", "UPI", "Card", "Net banking", "Insurance", "Other"] as const;

export class WalletValidationError extends Error {}

const money = (v: any) => Math.round(Number(v || 0) * 100) / 100;
const text = (v: any, max: number) => {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
};
/** yyyy-MM-dd, or null. Throws on anything else. */
const isoDate = (v: any, field: string): string | null => {
    const s = text(v, 10);
    if (!s) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new WalletValidationError(`${field} must be a date like 2026-11-02.`);
    return s;
};
const amount = (v: any, field: string, { required = false } = {}): number | null => {
    if (v === undefined || v === null || v === "") {
        if (required) throw new WalletValidationError(`${field} is required.`);
        return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) throw new WalletValidationError(`${field} must be an amount between 0 and 100,00,00,000.`);
    return money(n);
};
const status = (total: number, paid: number) => (paid >= total ? "Paid" : paid > 0 ? "Partly paid" : "Due");
/**
 * The India date of a value: a "YYYY-MM-DD" date column as it is, a datetime
 * (bill CreatedAt, payment TransactionDate) on India's clock, so a bill made
 * at 1 am IST is not shown under the day before.
 */
const dateOnly = (d: any) => {
    if (!d) return null;
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? null : new Date(t + 330 * 60_000).toISOString().slice(0, 10);
};

/** One row in My billing, whatever its source. */
type BillView = { id: string; source: "hospital" | "payment" | "manual"; date: string | null; category: string; total: number; paid: number; due: number } & Record<string, unknown>;

export interface WalletFile {
    url: string;
    name: string;
}

export class PatientWalletService {
    // ---------------------------------------------------------------- billing

    /**
     * Every bill for a patient in one list, newest first: bills Yira hospitals
     * raised (with their items and payments), online payments that have no
     * bill, and bills the patient added. Draft hospital bills with nothing paid
     * are left out until the hospital finalises them.
     */
    async getBilling(patientId: string) {
        const [hospital, payments, manual, lab] = await Promise.all([
            this.hospitalBills(patientId),
            this.unbilledPayments(patientId),
            AppDataSource.getRepository(PatientManualBill).find({ where: { PatientId: patientId, IsDeleted: false }, order: { BillDate: "DESC", Id: "DESC" } }),
            this.labPackageBills(patientId),
        ]);

        const billedIds = new Set(hospital.map((b) => b.billRef));
        const billedAppointments = new Set(hospital.map((b) => b.appointmentId).filter(Boolean));
        const receipts = payments.filter((p) => !(p.billRef && billedIds.has(p.billRef)) && !(p.appointmentId && billedAppointments.has(p.appointmentId)));

        const bills: BillView[] = [
            ...[...hospital, ...receipts].map(({ billRef, ...b }) => b),
            ...manual.map((m) => this.mapManual(m)),
            ...lab,
        ]
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));

        const year = String(new Date().getFullYear());
        const byCategory = new Map<string, number>();
        for (const b of bills) byCategory.set(b.category, money((byCategory.get(b.category) || 0) + b.total));

        return {
            summary: {
                count: bills.length,
                totalBilled: money(bills.reduce((s, b) => s + b.total, 0)),
                totalPaid: money(bills.reduce((s, b) => s + b.paid, 0)),
                totalDue: money(bills.reduce((s, b) => s + b.due, 0)),
                thisYear: money(bills.filter((b) => String(b.date).startsWith(year)).reduce((s, b) => s + b.total, 0)),
                byCategory: [...byCategory.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
            },
            bills,
        };
    }

    private async hospitalBills(patientId: string) {
        const { AppointmentBill } = await import("../../../models/Payments/appointment-bill.model.js");
        const { Payment } = await import("../../../models/Payments/payment.model.js");
        // Read directly rather than through the paged admin bills list, so no bill is dropped.
        const [rows, payments] = await Promise.all([
            AppDataSource.getRepository(AppointmentBill).find({
                where: { PatientId: patientId, IsDeleted: false },
                relations: ["Hospital", "Provider", "Appointment", "Appointment.Doctor", "BillItems"],
                order: { CreatedAt: "DESC" },
                take: 500,
            }),
            AppDataSource.getRepository(Payment).find({
                where: { PatientId: patientId, IsDeleted: false, Status: "Success" } as any,
                order: { CreatedAt: "DESC" },
                take: 500,
            }),
        ]);
        const methodFor = (b: any) => {
            const p = payments.find((x: any) => x.AppointmentBillId === b.AppointmentBillId || (b.AppointmentId && x.AppointmentId === b.AppointmentId));
            return p?.PaymentMethod || p?.PaymentGateway || (Number(b.PaidAmount) > 0 ? "Cash" : null);
        };
        return rows
            // Drafts until finalised, and bills cancelled with the visit (Billing shows them as Cancelled, nothing owed)
            .filter((b: any) => !((String(b.BillStatus) === "Draft" || String(b.BillStatus) === "Cancelled") && Number(b.PaidAmount) <= 0))
            .map((b: any) => {
                const total = money(b.TotalAmount);
                const paid = money(b.PaidAmount);
                const doctor = b.Provider || b.Appointment?.Doctor;
                const isProcedure = (b.BillItems || []).some((i: any) => String(i.ItemType) === "TreatmentPlan");
                return {
                    billRef: b.AppointmentBillId as string,
                    id: `h-${b.AppointmentBillId}`,
                    source: "hospital" as const,
                    title: isProcedure ? "Treatment bill" : "Consultation bill",
                    provider: b.Hospital?.Name || null,
                    doctor: doctor ? `Dr. ${[doctor.FirstName, doctor.LastName].filter(Boolean).join(" ")}` : null,
                    category: isProcedure ? "Procedure" : "Consultation",
                    date: dateOnly(b.Appointment?.AppointmentDate || b.CreatedAt),
                    billNumber: String(b.BillStatus) === "Draft" || String(b.BillNumber || "").startsWith("DFT-") ? null : b.BillNumber,
                    total,
                    paid,
                    due: money(Math.max(0, Number(b.DueAmount ?? total - paid))),
                    status: status(total, paid),
                    paymentMode: methodFor(b),
                    subTotal: money(b.SubTotal),
                    discount: money(b.DiscountAmount),
                    tax: money(b.GstAmount),
                    items: (b.BillItems || []).map((i: any) => ({
                        name: i.ItemName,
                        quantity: Number(i.Quantity || 1),
                        unitPrice: money(i.UnitPrice),
                        total: money(i.TotalAmount),
                    })),
                    notes: b.Notes || null,
                    fileUrl: null,
                    fileName: null,
                    appointmentId: b.AppointmentId || null,
                    editable: false,
                };
            });
    }

    /**
     * Paid lab package orders, each with its tax invoice (created here for orders paid before
     * invoices existed). Shown as hospital bills under "Lab tests".
     */
    private async labPackageBills(patientId: string): Promise<BillView[]> {
        const { LabPackageOrder } = await import("../../../models/LabPackages/lab-package-order.model.js");
        const { LabPackagePayment } = await import("../../../models/LabPackages/lab-package-payment.model.js");
        const { labInvoiceService, INVOICED_STATUSES } = await import("../../../services/LabPackages/lab-invoice.service.js");
        const repo = AppDataSource.getRepository(LabPackageOrder);
        const find = () => repo.find({
            where: { PatientId: patientId, Status: In(INVOICED_STATUSES) } as any,
            relations: ["Hospital"],
            order: { CreatedAt: "DESC" },
            take: 200,
        });
        let orders = await find();
        const missing = orders.filter((o) => !o.InvoiceUrl).map((o) => o.Id);
        if (missing.length) {
            await labInvoiceService.ensureInvoices(missing.slice(0, 20));
            orders = await find();
        }
        const payments = orders.length
            ? await AppDataSource.getRepository(LabPackagePayment).find({ where: { LabPackageOrderId: In(orders.map((o) => o.Id)), Status: "Success" } as any })
            : [];
        return orders.map((o: any) => {
            const pay = payments.find((p: any) => p.LabPackageOrderId === o.Id);
            const total = money(o.TotalAmount);
            return {
                id: `l-${o.Id}`,
                source: "hospital" as const,
                title: o.PackageName,
                provider: o.Hospital?.Name || null,
                doctor: null,
                category: "Lab tests",
                date: dateOnly(pay?.UpdatedAt || o.CreatedAt),
                billNumber: o.InvoiceNumber || o.OrderNumber,
                total,
                paid: total,
                due: 0,
                status: "Paid",
                paymentMode: pay?.Method || (total > 0 ? "Online" : null),
                subTotal: money(o.Price),
                discount: 0,
                tax: money(o.GstAmount),
                items: [{ name: o.PackageName, quantity: 1, unitPrice: money(o.Price), total: money(o.Price) }],
                notes: `Lab order ${o.OrderNumber}`,
                fileUrl: o.InvoiceUrl || null,
                fileName: o.InvoiceNumber ? `Invoice ${o.InvoiceNumber}.pdf` : null,
                appointmentId: null,
                editable: false,
            };
        });
    }

    /** Successful online payments, in case a hospital never raised a bill for them. */
    private async unbilledPayments(patientId: string) {
        const { Payment } = await import("../../../models/Payments/payment.model.js");
        const rows = await AppDataSource.getRepository(Payment).find({
            where: { PatientId: patientId, IsDeleted: false, Status: "Success" } as any,
            relations: ["Appointment", "Appointment.Hospital", "Appointment.Doctor"],
            order: { CreatedAt: "DESC" },
            take: 300,
        });
        return rows.map((p: any) => {
            const amt = money(p.Amount);
            const doctor = p.Appointment?.Doctor;
            return {
                billRef: (p.AppointmentBillId as string) || null,
                id: `p-${p.PaymentId}`,
                source: "payment" as const,
                title: "Consultation payment",
                provider: p.Appointment?.Hospital?.Name || null,
                doctor: doctor ? `Dr. ${[doctor.FirstName, doctor.LastName].filter(Boolean).join(" ")}` : null,
                category: "Consultation",
                date: dateOnly(p.TransactionDate || p.CreatedAt),
                billNumber: p.ReceiptNumber || null,
                total: amt,
                paid: amt,
                due: 0,
                status: "Paid",
                paymentMode: p.PaymentMethod || p.PaymentGateway || null,
                subTotal: amt,
                discount: 0,
                tax: 0,
                items: [],
                notes: null,
                fileUrl: null,
                fileName: null,
                appointmentId: p.AppointmentId || null,
                editable: false,
            };
        });
    }

    private mapManual(m: PatientManualBill) {
        const total = money(m.TotalAmount);
        const paid = money(m.PaidAmount);
        return {
            id: `m-${m.Id}`,
            source: "manual" as const,
            title: m.Title,
            provider: m.ProviderName ?? null,
            doctor: null,
            category: m.Category,
            date: dateOnly(m.BillDate),
            billNumber: m.BillNumber ?? null,
            total,
            paid,
            due: money(Math.max(0, total - paid)),
            status: status(total, paid),
            paymentMode: m.PaymentMode ?? null,
            subTotal: total,
            discount: 0,
            tax: 0,
            items: [],
            notes: m.Notes ?? null,
            fileUrl: m.FileUrl ?? null,
            fileName: m.FileName ?? null,
            appointmentId: null,
            editable: true,
        };
    }

    private billFields(body: any, existing?: PatientManualBill) {
        const title = text(body.title ?? existing?.Title, 150);
        if (!title) throw new WalletValidationError("Give the bill a name, for example 'Pharmacy bill'.");
        const category = text(body.category ?? existing?.Category, 40) || "Other";
        if (!(BILL_CATEGORIES as readonly string[]).includes(category)) throw new WalletValidationError(`Category must be one of: ${BILL_CATEGORIES.join(", ")}.`);
        const billDate = isoDate(body.billDate ?? existing?.BillDate, "Bill date");
        if (!billDate) throw new WalletValidationError("Bill date is required.");
        if (billDate > dateOnly(new Date(Date.now() + 86_400_000))!) throw new WalletValidationError("Bill date can't be in the future.");
        const total = amount(body.totalAmount ?? existing?.TotalAmount, "Amount", { required: true })!;
        // Paid defaults to the full amount: most bills people add are already paid.
        const paid = amount(body.paidAmount, "Paid amount") ?? (existing ? money(existing.PaidAmount) : total);
        if (paid > total) throw new WalletValidationError("Paid amount can't be more than the bill amount.");
        const mode = text(body.paymentMode ?? existing?.PaymentMode, 40);
        if (mode && !(PAYMENT_MODES as readonly string[]).includes(mode)) throw new WalletValidationError(`Payment mode must be one of: ${PAYMENT_MODES.join(", ")}.`);
        return {
            Title: title,
            ProviderName: text(body.providerName ?? existing?.ProviderName, 200),
            Category: category,
            BillDate: billDate,
            BillNumber: text(body.billNumber ?? existing?.BillNumber, 80),
            TotalAmount: total,
            PaidAmount: paid,
            PaymentMode: mode,
            Notes: text(body.notes ?? existing?.Notes, 1000),
        };
    }

    async addBill(patientId: string, createdBy: string, body: any, file?: WalletFile) {
        const repo = AppDataSource.getRepository(PatientManualBill);
        const row = repo.create({
            ...this.billFields(body),
            PatientId: patientId,
            CreatedByUserId: createdBy,
            FileUrl: file?.url ?? null,
            FileName: file?.name ?? null,
            IsDeleted: false,
            CreatedAt: new Date(),
        });
        return this.mapManual(await repo.save(row));
    }

    async updateBill(patientId: string, id: number, body: any, file?: WalletFile) {
        const repo = AppDataSource.getRepository(PatientManualBill);
        const row = await repo.findOne({ where: { Id: id, PatientId: patientId, IsDeleted: false } });
        if (!row) return null;
        Object.assign(row, this.billFields(body, row), { UpdatedAt: new Date() });
        if (file) Object.assign(row, { FileUrl: file.url, FileName: file.name });
        else if (body.removeFile === true || body.removeFile === "true") Object.assign(row, { FileUrl: null, FileName: null });
        return this.mapManual(await repo.save(row));
    }

    async deleteBill(patientId: string, id: number) {
        const res = await AppDataSource.getRepository(PatientManualBill).update(
            { Id: id, PatientId: patientId, IsDeleted: false },
            { IsDeleted: true, UpdatedAt: new Date() },
        );
        return (res.affected ?? 0) > 0;
    }

    // --------------------------------------------------------------- policies

    /** Policies the patient added, then insurance hospitals recorded at registration. */
    async getPolicies(patientId: string) {
        const { PatientInsurance } = await import("../../../models/Organizations/patient-insurance.model.js");
        const [own, registered] = await Promise.all([
            AppDataSource.getRepository(PatientPolicy).find({ where: { PatientId: patientId, IsDeleted: false }, order: { EndDate: "ASC", Id: "DESC" } }),
            AppDataSource.getRepository(PatientInsurance)
                .find({ where: { UserId: patientId, IsDeleted: false } as any, relations: ["Organization", "Hospital"], order: { CreatedAt: "DESC" } as any })
                .catch(() => [] as any[]),
        ]);
        const ownNumbers = new Set(own.map((p) => p.PolicyNumber.trim().toLowerCase()));
        return {
            policies: [
                ...own.map((p) => this.mapPolicy(p)),
                // A policy the patient also added themselves is shown once, as theirs.
                ...registered
                    .filter((r: any) => !ownNumbers.has(String(r.InsuranceNumber || "").trim().toLowerCase()))
                    .map((r: any) => ({
                        id: `h-${r.Id}`,
                        source: "hospital" as const,
                        policyType: "Health",
                        insurer: r.InsuranceProvider,
                        policyName: null,
                        policyNumber: r.InsuranceNumber,
                        memberId: null,
                        sumInsured: null,
                        premium: null,
                        startDate: null,
                        endDate: null,
                        tpaName: null,
                        helplineNumber: null,
                        coveredMembers: null,
                        notes: null,
                        fileUrl: null,
                        fileName: null,
                        addedBy: r.Hospital?.Name || r.Organization?.Name || null,
                        active: r.Status !== false,
                        editable: false,
                    })),
            ],
        };
    }

    private mapPolicy(p: PatientPolicy) {
        return {
            id: `m-${p.Id}`,
            source: "manual" as const,
            policyType: p.PolicyType,
            insurer: p.Insurer,
            policyName: p.PolicyName ?? null,
            policyNumber: p.PolicyNumber,
            memberId: p.MemberId ?? null,
            sumInsured: p.SumInsured == null ? null : money(p.SumInsured),
            premium: p.Premium == null ? null : money(p.Premium),
            startDate: dateOnly(p.StartDate),
            endDate: dateOnly(p.EndDate),
            tpaName: p.TpaName ?? null,
            helplineNumber: p.HelplineNumber ?? null,
            coveredMembers: p.CoveredMembers ?? null,
            notes: p.Notes ?? null,
            fileUrl: p.FileUrl ?? null,
            fileName: p.FileName ?? null,
            addedBy: null,
            active: true,
            editable: true,
        };
    }

    private policyFields(body: any, existing?: PatientPolicy) {
        const insurer = text(body.insurer ?? existing?.Insurer, 200);
        if (!insurer) throw new WalletValidationError("Insurer is required, for example 'Star Health'.");
        const policyNumber = text(body.policyNumber ?? existing?.PolicyNumber, 100);
        if (!policyNumber) throw new WalletValidationError("Policy number is required.");
        const policyType = text(body.policyType ?? existing?.PolicyType, 40) || "Health";
        if (!(POLICY_TYPES as readonly string[]).includes(policyType)) throw new WalletValidationError(`Policy type must be one of: ${POLICY_TYPES.join(", ")}.`);
        const startDate = isoDate(body.startDate === undefined ? existing?.StartDate : body.startDate, "Start date");
        const endDate = isoDate(body.endDate === undefined ? existing?.EndDate : body.endDate, "Renewal date");
        if (startDate && endDate && endDate < startDate) throw new WalletValidationError("Renewal date must be after the start date.");
        const keep = <T>(key: string, current: T | undefined) => (body[key] === undefined ? current : body[key]);
        return {
            PolicyType: policyType,
            Insurer: insurer,
            PolicyName: text(keep("policyName", existing?.PolicyName), 200),
            PolicyNumber: policyNumber,
            MemberId: text(keep("memberId", existing?.MemberId), 100),
            SumInsured: amount(keep("sumInsured", existing?.SumInsured), "Sum insured"),
            Premium: amount(keep("premium", existing?.Premium), "Premium"),
            StartDate: startDate,
            EndDate: endDate,
            TpaName: text(keep("tpaName", existing?.TpaName), 200),
            HelplineNumber: text(keep("helplineNumber", existing?.HelplineNumber), 40),
            CoveredMembers: text(keep("coveredMembers", existing?.CoveredMembers), 500),
            Notes: text(keep("notes", existing?.Notes), 1000),
        };
    }

    async addPolicy(patientId: string, createdBy: string, body: any, file?: WalletFile) {
        const repo = AppDataSource.getRepository(PatientPolicy);
        const row = repo.create({
            ...this.policyFields(body),
            PatientId: patientId,
            CreatedByUserId: createdBy,
            FileUrl: file?.url ?? null,
            FileName: file?.name ?? null,
            IsDeleted: false,
            CreatedAt: new Date(),
        });
        return this.mapPolicy(await repo.save(row));
    }

    async updatePolicy(patientId: string, id: number, body: any, file?: WalletFile) {
        const repo = AppDataSource.getRepository(PatientPolicy);
        const row = await repo.findOne({ where: { Id: id, PatientId: patientId, IsDeleted: false } });
        if (!row) return null;
        Object.assign(row, this.policyFields(body, row), { UpdatedAt: new Date() });
        if (file) Object.assign(row, { FileUrl: file.url, FileName: file.name });
        else if (body.removeFile === true || body.removeFile === "true") Object.assign(row, { FileUrl: null, FileName: null });
        return this.mapPolicy(await repo.save(row));
    }

    async deletePolicy(patientId: string, id: number) {
        const res = await AppDataSource.getRepository(PatientPolicy).update(
            { Id: id, PatientId: patientId, IsDeleted: false },
            { IsDeleted: true, UpdatedAt: new Date() },
        );
        return (res.affected ?? 0) > 0;
    }
}

export const patientWalletService = new PatientWalletService();
