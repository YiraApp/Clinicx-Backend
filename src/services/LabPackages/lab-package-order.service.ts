import Razorpay from "razorpay";
import crypto from "crypto";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";
import { In } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { LabPackage } from "../../models/LabPackages/lab-package.model.js";
import { LabPackageHospital } from "../../models/LabPackages/lab-package-hospital.model.js";
import { LabPackageOrder } from "../../models/LabPackages/lab-package-order.model.js";
import { LabPackagePayment } from "../../models/LabPackages/lab-package-payment.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { MedicalDocument } from "../../models/Appointments/medical-document.model.js";
import { isYiraSystemAdmin, staffHospitalIds, canManageHospital } from "../../utils/staff-access.js";
import { isFamilyLinked } from "../../middlewares/request-identity.js";
import { labPackageService, labPackageAmounts, roundMoney } from "./lab-package.service.js";
import { LabAccessError } from "./lab-access-error.js";
import { labSlotService, slotInstant, slotLabel, RESCHEDULE_CUTOFF_HOURS } from "./lab-slot.service.js";

export { LabAccessError };

/** The order moves forward through these; Cancelled is possible until Completed. */
const PROGRESS = ["Paid", "SampleCollected", "ReportReady", "Completed"];
const STATUS_LABELS: Record<string, string> = {
    PaymentPending: "Payment Pending",
    Paid: "Paid",
    SampleCollected: "Sample Collected",
    ReportReady: "Report Ready",
    Completed: "Completed",
    Cancelled: "Cancelled"
};

/** Order ids are GUIDs; anything else would make SQL Server fail the conversion. */
const isOrderId = (id?: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || "").trim());

function signaturesMatch(expected: string, received: string) {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(received || ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A SQL `date` as "YYYY-MM-DD" (the driver returns it as a Date at UTC midnight). */
const dateOnly = (value: unknown): string | null => {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    const s = String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const readTests = (value?: string | null): string[] => {
    try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
};

export class LabPackageOrderService {
    private orderRepo = AppDataSource.getRepository(LabPackageOrder);
    private paymentRepo = AppDataSource.getRepository(LabPackagePayment);

    /** The hospital's own Razorpay keys. Lab package payments never use Yira's keys. */
    private async hospitalKeys(hospitalId: number) {
        const config = await AppDataSource.getRepository(HospitalPaymentConfiguration).findOne({
            where: { HospitalId: hospitalId, IsDeleted: false, IsActive: true }
        });
        if (!config?.RazorpayKeyId || !config.RazorpayKeySecret) {
            throw new Error("Online payment is not set up at this hospital. Choose another hospital.");
        }
        return { keyId: config.RazorpayKeyId, keySecret: config.RazorpayKeySecret, currency: config.CurrencyCode || "INR" };
    }

    private orderNumber() {
        const d = new Date();
        const ymd = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
        return `LPO-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    }

    /**
     * Whether the patient can pick or move the visit slot now: only once paid and before the sample
     * is collected, and only until RESCHEDULE_CUTOFF_HOURS before the booked slot.
     */
    slotState(order: LabPackageOrder, now = new Date()) {
        const visitDate = dateOnly(order.PreferredDate);
        const hasSlot = !!(visitDate && order.SlotStart && order.SlotEnd);
        const startsAt = hasSlot ? slotInstant(visitDate!, order.SlotStart!) : null;
        const changeUntil = startsAt ? new Date(startsAt.getTime() - RESCHEDULE_CUTOFF_HOURS * 3600000) : null;
        let reason: string | null = null;
        if (order.Status === "PaymentPending") reason = "Pay for the order to choose a slot.";
        else if (order.Status === "Cancelled") reason = "This order is cancelled.";
        else if (order.Status !== "Paid") reason = "The sample is already collected.";
        else if (changeUntil && now > changeUntil) {
            reason = `Slots can be changed until ${RESCHEDULE_CUTOFF_HOURS} hours before the visit. Call the hospital to change it.`;
        }
        return {
            slot: hasSlot ? {
                date: visitDate!,
                start: order.SlotStart!,
                end: order.SlotEnd!,
                label: slotLabel(order.SlotStart!, order.SlotEnd!),
                startsAt
            } : null,
            canChangeSlot: reason === null,
            slotChangeUntil: changeUntil,
            slotLockedReason: reason,
            rescheduleCount: Number(order.RescheduleCount || 0)
        };
    }

    toDto(order: LabPackageOrder, payment?: LabPackagePayment | null) {
        return {
            ...this.slotState(order),
            id: order.Id,
            orderNumber: order.OrderNumber,
            packageId: order.LabPackageId,
            packageName: order.PackageName,
            tests: readTests(order.TestsIncluded),
            price: Number(order.Price || 0),
            gstPercentage: Number(order.GstPercentage || 0),
            gstAmount: Number(order.GstAmount || 0),
            totalAmount: Number(order.TotalAmount || 0),
            patientId: order.PatientId,
            patientName: order.Patient ? `${order.Patient.FirstName || ""} ${order.Patient.LastName || ""}`.trim() : "",
            patientPhone: order.Patient?.PhoneNumber || "",
            hospitalId: order.HospitalId,
            hospitalName: order.Hospital?.Name || "",
            pincode: order.Pincode || "",
            preferredDate: dateOnly(order.PreferredDate),
            notes: order.Notes || "",
            status: order.Status,
            statusLabel: STATUS_LABELS[order.Status] || order.Status,
            hasReport: !!order.ReportUrl,
            reportFileName: order.ReportFileName || null,
            reportUploadedAt: order.ReportUploadedAt || null,
            createdAt: order.CreatedAt,
            updatedAt: order.UpdatedAt || null,
            payment: payment ? {
                transactionId: payment.TransactionId,
                gatewayPaymentId: payment.GatewayPaymentId || null,
                method: payment.Method || null,
                status: payment.Status,
                amount: Number(payment.Amount || 0),
                paidAt: payment.Status === "Success" ? (payment.UpdatedAt || payment.CreatedAt) : null
            } : null
        };
    }

    /** The latest payment of each order: the successful one when there is one. */
    private async paymentsFor(orderIds: string[]): Promise<Map<string, LabPackagePayment>> {
        const map = new Map<string, LabPackagePayment>();
        if (orderIds.length === 0) return map;
        const payments = await this.paymentRepo.find({ where: { LabPackageOrderId: In(orderIds) }, order: { CreatedAt: "DESC" } });
        for (const p of payments) {
            const key = p.LabPackageOrderId.toUpperCase();
            const current = map.get(key);
            if (!current || (current.Status !== "Success" && p.Status === "Success")) map.set(key, p);
        }
        return map;
    }

    // ---------- Patient ----------

    /**
     * Starts a purchase: checks the package is offered at the hospital (and in the pincode), then
     * creates the Razorpay order with the hospital's keys for the package's total including GST,
     * and saves the order and its pending payment. The amount is never taken from the app.
     */
    async createOrder(patientId: string, data: { packageId: number; hospitalId: number; pincode?: string; preferredDate?: string; slotStart?: string; notes?: string }) {
        const packageId = Number(data.packageId);
        const hospitalId = Number(data.hospitalId);
        if (!(packageId > 0) || !(hospitalId > 0)) throw new Error("Choose a package and a hospital.");

        const pkg = await AppDataSource.getRepository(LabPackage).findOne({ where: { Id: packageId, IsDeleted: false, IsActive: true, ShowInMobileApp: true } });
        if (!pkg) throw new Error("This lab package is no longer available.");

        const offered = await AppDataSource.getRepository(LabPackageHospital).count({ where: { LabPackageId: packageId, HospitalId: hospitalId } });
        if (!offered) throw new Error("This package is not offered at the selected hospital.");
        if (!(await labPackageService.payableHospitalIds([hospitalId])).has(hospitalId)) {
            throw new Error("Online payment is not set up at this hospital. Choose another hospital.");
        }

        // Outside the package's pincodes it can still be booked at the default hospital, whose
        // packages the app shows when nothing is offered in the patient's pincode.
        const pincode = String(data.pincode || "").replace(/\D/g, "") || null;
        if (!labPackageService.servesPincode(pkg, pincode)) {
            const def = await labPackageService.defaultHospital();
            if (!def || def.id !== hospitalId) throw new Error("This package is not offered in your pincode.");
        }

        // The visit slot is optional here; the patient can also choose it from My Orders after paying
        let preferredDate: string | null = null;
        let slot: { start: string; end: string } | null = null;
        if (data.slotStart) {
            const chosen = await labSlotService.validateChoice(hospitalId, data.preferredDate, data.slotStart);
            preferredDate = chosen.date;
            slot = { start: chosen.start, end: chosen.end };
        } else if (data.preferredDate) {
            const d = String(data.preferredDate).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("Preferred date must be YYYY-MM-DD.");
            const today = new Date().toISOString().slice(0, 10);
            if (d < today) throw new Error("Preferred date cannot be in the past.");
            preferredDate = d;
        }

        const hospital = await AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId } });
        const amounts = labPackageAmounts(Number(pkg.Price), Number(pkg.GstPercentage));
        const orderId = uuidv4().toUpperCase();
        const transactionId = `LAB_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;
        const order = this.orderRepo.create({
            Id: orderId,
            OrderNumber: this.orderNumber(),
            LabPackageId: pkg.Id,
            PackageName: pkg.Name,
            TestsIncluded: pkg.TestsIncluded,
            Price: amounts.price,
            GstPercentage: amounts.gstPercentage,
            GstAmount: amounts.gstAmount,
            TotalAmount: amounts.totalAmount,
            PatientId: patientId,
            HospitalId: hospitalId,
            OrganizationId: hospital?.OrganizationId ?? null,
            Pincode: pincode,
            PreferredDate: preferredDate,
            SlotStart: slot?.start ?? null,
            SlotEnd: slot?.end ?? null,
            SlotUpdatedAt: slot ? new Date() : null,
            RescheduleCount: 0,
            Notes: data.notes ? String(data.notes).trim().slice(0, 500) : null,
            Status: "PaymentPending",
            CreatedAt: new Date()
        });

        // A free package needs no payment
        if (amounts.totalAmount <= 0) {
            order.Status = "Paid";
            await this.orderRepo.save(order);
            return { orderId, orderNumber: order.OrderNumber, requiresPayment: false, amount: 0 };
        }

        const keys = await this.hospitalKeys(hospitalId);
        const razorpay = new Razorpay({ key_id: keys.keyId, key_secret: keys.keySecret });
        const rzpOrder = await razorpay.orders.create({
            amount: Math.round(amounts.totalAmount * 100),
            currency: keys.currency,
            receipt: transactionId,
            notes: { type: "LAB_PACKAGE", labPackageOrderId: orderId }
        });

        await AppDataSource.transaction(async (manager) => {
            await manager.save(LabPackageOrder, order);
            await manager.save(LabPackagePayment, manager.create(LabPackagePayment, {
                Id: uuidv4().toUpperCase(),
                LabPackageOrderId: orderId,
                HospitalId: hospitalId,
                TransactionId: transactionId,
                GatewayOrderId: rzpOrder.id,
                Amount: amounts.totalAmount,
                Currency: keys.currency,
                Status: "Pending",
                CreatedAt: new Date()
            }));
        });

        return {
            orderId,
            orderNumber: order.OrderNumber,
            requiresPayment: true,
            razorpayOrderId: rzpOrder.id,
            key: keys.keyId,
            transactionId,
            amount: amounts.totalAmount,
            currency: keys.currency,
            packageName: pkg.Name,
            hospitalName: hospital?.Name || ""
        };
    }

    /** Moves a pending payment to Success and its order to Paid, exactly once. */
    private async markPaid(payment: LabPackagePayment, fields: Partial<LabPackagePayment>): Promise<boolean> {
        let transitioned = false;
        await AppDataSource.transaction(async (manager) => {
            const res = await manager.createQueryBuilder().update(LabPackagePayment)
                .set({ ...fields, Status: "Success", FailureReason: null, UpdatedAt: new Date() })
                .where("Id = :id AND Status <> 'Success'", { id: payment.Id })
                .execute();
            transitioned = (res.affected || 0) > 0;
            if (!transitioned) return;
            await manager.createQueryBuilder().update(LabPackageOrder)
                .set({ Status: "Paid", UpdatedAt: new Date() })
                .where("Id = :id AND Status = 'PaymentPending'", { id: payment.LabPackageOrderId })
                .execute();
        });
        return transitioned;
    }

    /** Checks the checkout's signature with the hospital's secret and records the payment. */
    async verifyPayment(data: { transactionId: string; razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) {
        const payment = await this.paymentRepo.findOne({ where: { TransactionId: String(data.transactionId || "") } });
        if (!payment) throw new Error("Payment record not found.");
        if (payment.GatewayOrderId !== data.razorpay_order_id) throw new Error("This payment does not belong to the order.");

        const keys = await this.hospitalKeys(payment.HospitalId);
        const expected = crypto.createHmac("sha256", keys.keySecret)
            .update(`${data.razorpay_order_id}|${data.razorpay_payment_id}`)
            .digest("hex");
        if (!signaturesMatch(expected, data.razorpay_signature)) {
            await this.paymentRepo.createQueryBuilder().update(LabPackagePayment)
                .set({ Status: "Failed", FailureReason: "Signature mismatch", UpdatedAt: new Date() })
                .where("Id = :id AND Status <> 'Success'", { id: payment.Id })
                .execute();
            throw new Error("Payment verification failed.");
        }

        await this.markPaid(payment, {
            GatewayPaymentId: data.razorpay_payment_id,
            GatewaySignature: data.razorpay_signature,
            Method: "Razorpay"
        });
        const order = await this.orderRepo.findOne({ where: { Id: payment.LabPackageOrderId }, relations: ["Hospital"] });
        return { success: true, orderId: payment.LabPackageOrderId, orderNumber: order?.OrderNumber, status: order?.Status };
    }

    /**
     * Razorpay webhook for a captured payment. Returns false when the order is not a lab package
     * order, so the caller can treat it as an appointment payment.
     */
    async handleCaptured(gatewayOrderId: string, gatewayPaymentId: string, method?: string): Promise<boolean> {
        const payment = await this.paymentRepo.findOne({ where: { GatewayOrderId: gatewayOrderId } });
        if (!payment) return false;
        if (payment.Status !== "Success") {
            await this.markPaid(payment, { GatewayPaymentId: gatewayPaymentId, Method: method || "Razorpay" });
        }
        return true;
    }

    /** The patient's orders; checkouts that were never paid are left out. */
    async myOrders(patientId: string) {
        const orders = await this.orderRepo.createQueryBuilder("o")
            .leftJoinAndSelect("o.Hospital", "h")
            .where("o.PatientId = :patientId", { patientId })
            .andWhere("o.Status <> 'PaymentPending'")
            .orderBy("o.CreatedAt", "DESC")
            .getMany();
        const payments = await this.paymentsFor(orders.map(o => o.Id));
        return orders.map(o => this.toDto(o, payments.get(o.Id.toUpperCase())));
    }

    /** The patient's (or a family member's) order, or 404. */
    private async orderForPatient(requesterId: string, orderId: string) {
        if (!isOrderId(orderId)) throw new LabAccessError("Order not found.", 404);
        const order = await this.orderRepo.findOne({ where: { Id: orderId }, relations: ["Hospital"] });
        if (!order || !(await isFamilyLinked(requesterId, order.PatientId))) throw new LabAccessError("Order not found.", 404);
        return order;
    }

    /** Slots the patient can book: for an order (its hospital) or for a hospital at checkout. */
    async slotOptions(requesterId: string, data: { orderId?: string; hospitalId?: number }) {
        let hospitalId = Number(data.hospitalId) || 0;
        if (data.orderId) hospitalId = (await this.orderForPatient(requesterId, String(data.orderId))).HospitalId;
        if (!(hospitalId > 0)) throw new Error("Choose a hospital.");
        return labSlotService.bookableDays(hospitalId);
    }

    /** The patient picks or moves the visit slot of a paid order, until the cutoff before the current slot. */
    async setSlot(requesterId: string, orderId: string, data: { date?: string; slotStart?: string }) {
        const order = await this.orderForPatient(requesterId, orderId);
        const state = this.slotState(order);
        if (!state.canChangeSlot) throw new Error(state.slotLockedReason || "The slot can no longer be changed.");
        const chosen = await labSlotService.validateChoice(order.HospitalId, data.date, data.slotStart);
        const unchanged = state.slot && state.slot.date === chosen.date && state.slot.start === chosen.start;
        if (!unchanged) {
            await this.orderRepo.update(order.Id, {
                PreferredDate: chosen.date,
                SlotStart: chosen.start,
                SlotEnd: chosen.end,
                SlotUpdatedAt: new Date(),
                RescheduleCount: Number(order.RescheduleCount || 0) + (state.slot ? 1 : 0),
                UpdatedAt: new Date(),
                UpdatedBy: requesterId
            });
        }
        const updated = await this.orderRepo.findOne({ where: { Id: order.Id }, relations: ["Hospital"] });
        const payments = await this.paymentsFor([order.Id]);
        return this.toDto(updated!, payments.get(order.Id.toUpperCase()));
    }

    // ---------- Staff (Yira System Admin: every hospital; hospital staff: their hospitals) ----------

    /** null means every hospital (Yira System Admin). */
    private async allowedHospitals(requesterId: string): Promise<number[] | null> {
        if (await isYiraSystemAdmin(requesterId)) return null;
        const ids = await staffHospitalIds(requesterId);
        if (ids.length === 0) throw new LabAccessError("You do not have access to lab package orders.");
        return ids;
    }

    async listOrders(requesterId: string, filters: { hospitalId?: number; status?: string; search?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) {
        const allowed = await this.allowedHospitals(requesterId);
        const page = Math.max(1, Number(filters.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));

        const apply = (qb: any) => {
            if (allowed) qb.andWhere("o.HospitalId IN (:...allowed)", { allowed });
            if (filters.hospitalId) {
                if (allowed && !allowed.includes(Number(filters.hospitalId))) throw new LabAccessError("You do not have access to this hospital's orders.");
                qb.andWhere("o.HospitalId = :hid", { hid: Number(filters.hospitalId) });
            }
            if (filters.status && filters.status !== "All") qb.andWhere("o.Status = :status", { status: filters.status });
            if (filters.search?.trim()) {
                qb.andWhere("(o.OrderNumber LIKE :s OR o.PackageName LIKE :s OR p.FirstName LIKE :s OR p.LastName LIKE :s OR p.PhoneNumber LIKE :s)", { s: `%${filters.search.trim()}%` });
            }
            if (filters.startDate) qb.andWhere("o.CreatedAt >= :start", { start: new Date(filters.startDate) });
            if (filters.endDate) {
                const end = new Date(filters.endDate);
                end.setHours(23, 59, 59, 999);
                qb.andWhere("o.CreatedAt <= :end", { end });
            }
            return qb;
        };

        const listQb = apply(this.orderRepo.createQueryBuilder("o")
            .leftJoinAndSelect("o.Patient", "p")
            .leftJoinAndSelect("o.Hospital", "h")
            .where("1 = 1"));
        const [orders, total] = await listQb.orderBy("o.CreatedAt", "DESC").skip((page - 1) * limit).take(limit).getManyAndCount();

        const summary = await apply(this.orderRepo.createQueryBuilder("o")
            .leftJoin("o.Patient", "p")
            .select("COUNT(*)", "orders")
            .addSelect("SUM(CASE WHEN o.Status IN ('Paid','SampleCollected','ReportReady','Completed') THEN o.TotalAmount ELSE 0 END)", "collected")
            .addSelect("SUM(CASE WHEN o.Status IN ('Paid','SampleCollected') THEN 1 ELSE 0 END)", "awaitingReport")
            .where("1 = 1")).getRawOne();

        const payments = await this.paymentsFor(orders.map((o: LabPackageOrder) => o.Id));
        return {
            data: orders.map((o: LabPackageOrder) => this.toDto(o, payments.get(o.Id.toUpperCase()))),
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            summary: {
                orders: Number(summary?.orders || 0),
                collected: roundMoney(Number(summary?.collected || 0)),
                awaitingReport: Number(summary?.awaitingReport || 0)
            },
            isAllHospitals: allowed === null
        };
    }

    private async orderForStaff(requesterId: string, orderId: string) {
        if (!isOrderId(orderId)) throw new LabAccessError("Order not found.", 404);
        const order = await this.orderRepo.findOne({ where: { Id: orderId }, relations: ["Patient", "Hospital"] });
        if (!order) throw new LabAccessError("Order not found.", 404);
        if (!(await canManageHospital(requesterId, order.HospitalId))) {
            throw new LabAccessError("You do not have access to this order.");
        }
        return order;
    }

    async updateStatus(requesterId: string, orderId: string, status: string) {
        const order = await this.orderForStaff(requesterId, orderId);
        const next = String(status || "").trim();
        if (!STATUS_LABELS[next] || next === "PaymentPending") throw new Error("Choose a valid status.");
        if (order.Status === next) return this.toDto(order);
        if (order.Status === "Completed" || order.Status === "Cancelled") {
            throw new Error(`A ${STATUS_LABELS[order.Status].toLowerCase()} order cannot be changed.`);
        }
        if (next !== "Cancelled") {
            if (order.Status === "PaymentPending") throw new Error("This order has not been paid yet.");
            if (PROGRESS.indexOf(next) < PROGRESS.indexOf(order.Status)) {
                throw new Error(`An order cannot go back from ${STATUS_LABELS[order.Status]} to ${STATUS_LABELS[next]}.`);
            }
            if (next === "ReportReady" && !order.ReportUrl) throw new Error("Upload the report first.");
        }
        order.Status = next;
        order.UpdatedAt = new Date();
        order.UpdatedBy = requesterId;
        await this.orderRepo.save(order);
        const payments = await this.paymentsFor([order.Id]);
        return this.toDto(order, payments.get(order.Id.toUpperCase()));
    }

    async uploadReport(requesterId: string, orderId: string, file: Express.Multer.File | undefined) {
        if (!file) throw new Error("Choose the report file to upload.");
        const type = mime.lookup(file.originalname) || file.mimetype || "";
        if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/i.test(String(type))) {
            throw new Error("The report must be a PDF or an image (PNG, JPG, WEBP).");
        }
        const order = await this.orderForStaff(requesterId, orderId);
        if (order.Status === "PaymentPending") throw new Error("This order has not been paid yet.");
        if (order.Status === "Cancelled") throw new Error("This order is cancelled.");

        const { blobService } = await import("../Common/blob.service.js");
        const [uploaded] = await blobService.uploadFiles([file], `labpackage_${order.HospitalId}`, `LabPackageReports_${order.OrderNumber}`);
        order.ReportUrl = uploaded.fileUrl;
        order.ReportFileName = file.originalname;
        order.ReportUploadedAt = new Date();
        order.ReportUploadedBy = requesterId;
        if (order.Status === "Paid" || order.Status === "SampleCollected") order.Status = "ReportReady";
        order.MedicalDocumentId = await this.savePatientDocument(order, file, uploaded.fileUrl, requesterId);
        order.UpdatedAt = new Date();
        order.UpdatedBy = requesterId;
        await this.orderRepo.save(order);
        const payments = await this.paymentsFor([order.Id]);
        return this.toDto(order, payments.get(order.Id.toUpperCase()));
    }

    /**
     * Puts the report in the patient's documents (MedicalDocuments, category "Lab Report", at the
     * order's hospital), so it shows in Hospital Patients → Documents and the patient's records.
     * Replacing the report updates the same document; one deleted from Documents is added again.
     * No WhatsApp or push message is sent. Returns the document id.
     */
    private async savePatientDocument(order: LabPackageOrder, file: Express.Multer.File, fileUrl: string, requesterId: string) {
        const repo = AppDataSource.getRepository(MedicalDocument);
        let doc = order.MedicalDocumentId ? await repo.findOne({ where: { Id: Number(order.MedicalDocumentId), IsDeleted: false } }) : null;
        const isNew = !doc;
        if (!doc) doc = repo.create({ IsDeleted: false, CreatedAt: new Date(), CreatedBy: requesterId });

        const organizationId = order.OrganizationId
            ?? (order.Hospital?.OrganizationId as number | undefined)
            ?? (await AppDataSource.getRepository(Hospital).findOne({ where: { Id: order.HospitalId } }))?.OrganizationId
            ?? 1;
        const dot = file.originalname.lastIndexOf(".");
        const extension = dot >= 0 ? file.originalname.slice(dot).toLowerCase() : ".pdf";

        Object.assign(doc, {
            PatientId: order.PatientId,
            OrganizationId: Number(organizationId),
            HospitalId: order.HospitalId,
            DocumentCategory: "Lab Report",
            DocumentType: extension.replace(".", "").toUpperCase() || "PDF",
            FileName: file.originalname.slice(0, 255),
            OriginalFileName: file.originalname.slice(0, 255),
            BlobUrl: fileUrl,
            MimeType: String(mime.lookup(file.originalname) || file.mimetype || "application/octet-stream"),
            FileExtension: extension,
            FileSize: file.size,
            Description: `Lab package report: ${order.PackageName} (order ${order.OrderNumber})`.slice(0, 4000),
            Tags: `lab-package,${order.OrderNumber}`,
            UploadedSource: "LabPackage",
            UploadedByUserId: requesterId,
            IsPatientUploaded: false,
            IsDoctorUploaded: true,
            IsSystemGenerated: false,
            Status: "ACTIVE",
            ...(isNew ? {} : { UpdatedAt: new Date(), UpdatedBy: requesterId })
        });
        const saved = await repo.save(doc);
        return Number(saved.Id);
    }

    /** Adds reports uploaded before they were copied to the patient's documents. Returns how many. */
    async backfillPatientDocuments(): Promise<number> {
        const orders = await this.orderRepo.createQueryBuilder("o")
            .leftJoinAndSelect("o.Hospital", "h")
            .where("o.ReportUrl IS NOT NULL AND o.MedicalDocumentId IS NULL")
            .getMany();
        for (const order of orders) {
            const name = order.ReportFileName || `${order.OrderNumber}.pdf`;
            const file = { originalname: name, size: 0, mimetype: String(mime.lookup(name) || "application/pdf") } as Express.Multer.File;
            const docId = await this.savePatientDocument(order, file, order.ReportUrl!, order.ReportUploadedBy || order.UpdatedBy || order.PatientId);
            await this.orderRepo.update(order.Id, { MedicalDocumentId: docId });
        }
        return orders.length;
    }

    private async reportFile(order: LabPackageOrder) {
        if (!order.ReportUrl) throw new LabAccessError("No report has been uploaded for this order yet.", 404);
        const { blobService } = await import("../Common/blob.service.js");
        const buffer = await blobService.downloadFile(order.ReportUrl);
        const fileName = order.ReportFileName || `${order.OrderNumber}.pdf`;
        return { buffer, fileName, contentType: String(mime.lookup(fileName) || "application/octet-stream") };
    }

    async reportForStaff(requesterId: string, orderId: string) {
        return this.reportFile(await this.orderForStaff(requesterId, orderId));
    }

    /** The patient (or an account in their family) downloads their own report. */
    async reportForPatient(requesterId: string, orderId: string) {
        return this.reportFile(await this.orderForPatient(requesterId, orderId));
    }
}

export const labPackageOrderService = new LabPackageOrderService();
