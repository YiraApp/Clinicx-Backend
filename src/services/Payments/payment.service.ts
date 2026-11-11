import Razorpay from "razorpay";
import crypto from "crypto";
import { paymentRepository } from "../../repositories/Payments/payment.repository.js";
import { paymentLogRepository } from "../../repositories/Payments/payment-log.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { appointmentBillRepository, roundMoney } from "../../repositories/Payments/appointment-bill.repository.js";
import { AppDataSource } from "../../config/database.js";
import { v4 as uuidv4 } from "uuid";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { mailService } from "../Mail/mail.service.js";
import { smsService } from "../Common/sms.service.js";
import { Payment } from "../../models/Payments/payment.model.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { IsNull } from "typeorm/index.js";
import { razorpayKeyProblem, razorpayOrderError } from "../../utils/razorpay.utils.js";

// A payment confirms the appointment (and sends the confirmation messages) only while it is still
// waiting for payment; collecting a balance after the visit must not move it back to Confirmed.
const AWAITING_CONFIRMATION_STATUSES = ["paymentpending", "pendingpayment", "pending", "scheduled"];
const isAwaitingConfirmation = (status?: string | null) => !status || AWAITING_CONFIRMATION_STATUSES.includes(status.toLowerCase());

// Logged on a payment taken from the Billing page (notify: false): it confirms the appointment but
// sends no WhatsApp or push messages, whether the checkout callback or the webhook completes it.
const NOTIFY_SUPPRESSED_EVENT = "NOTIFY_SUPPRESSED";

/**
 * The Razorpay keys a hospital's orders are created and verified with: its own account when both of
 * its keys are saved, else the app's account from the environment. Keys are never hard-coded.
 */
function resolveRazorpayKeys(config?: HospitalPaymentConfiguration | null) {
    if (config?.RazorpayKeyId && config.RazorpayKeySecret) {
        return { keyId: config.RazorpayKeyId, keySecret: config.RazorpayKeySecret };
    }
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error("Online payment is not configured for this hospital.");
    return { keyId, keySecret };
}

/** Compares two signatures without revealing how much of them matched. */
function signaturesMatch(expected: string, received: string) {
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The configuration as the browser may see it: whether a key secret is saved, never the secret. */
function withoutKeySecret(config: HospitalPaymentConfiguration) {
    const { RazorpayKeySecret, ...rest } = config;
    return { ...rest, HasRazorpayKeySecret: !!RazorpayKeySecret };
}

export class PaymentService {
    /**
     * Create a Razorpay order and generate a pending Payment record.
     */
    async createOrder(data: { appointmentId?: number | null; patientId: string; amount: number; providerId?: string; billId?: string; notify?: boolean }) {
        const transactionId = `TXN_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;

        // The hospital comes from the appointment, or from the bill for a manual bill that has none
        const appointment = data.appointmentId ? await appointmentRepository.findById(data.appointmentId) : null;
        if (data.appointmentId && !appointment) throw new Error("Appointment not found.");
        let bill = await this.resolveBill(data);
        if (!appointment && !bill) throw new Error("Bill not found.");
        const hospitalId = appointment ? appointment.HospitalId : bill!.HospitalId;

        // Retrieve hospital-scoped payment configurations
        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const config = await configRepo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });

        // Use the hospital's own Razorpay credentials if configured, otherwise the app's from the environment
        const { keyId: rzpKeyId, keySecret: rzpKeySecret } = resolveRazorpayKeys(config);

        const customRazorpay = new Razorpay({
            key_id: rzpKeyId,
            key_secret: rzpKeySecret
        });

        // Ensure AppointmentBill exists — create if not (only an appointment can be without one here)
        if (!bill) {
            bill = await appointmentBillRepository.createBillWithItem({
                appointmentId: appointment!.Id,
                patientId: data.patientId,
                providerId: data.providerId,
                hospitalId,
                consultationFee: Number(data.amount),
                config
            });
        }

        // A draft keeps its DFT- number after a cash part-payment changes its status, so check both
        if (bill.BillStatus === "Draft" || !bill.BillNumber || bill.BillNumber.startsWith("DFT-")) {
            // Automatically generate the invoice (finalizing it from Draft to Pending state)
            // to allow online payment initialization to proceed seamlessly
            bill = await appointmentBillRepository.generateInvoice(bill.AppointmentBillId);
        }

        if (bill.BillStatus === "Cancelled") throw new Error("This bill is cancelled.");
        const dueAmount = roundMoney(Number(bill.TotalAmount) - Number(bill.PaidAmount));
        if (dueAmount <= 0) throw new Error("This bill is already fully paid.");

        // Charge what the caller asked for (partial payments are allowed), but never more than is due
        const requestedAmount = roundMoney(Number(data.amount));
        const chargeAmount = requestedAmount > 0 ? Math.min(requestedAmount, dueAmount) : dueAmount;

        // Call Razorpay API to generate order
        const options = {
            amount: Math.round(chargeAmount * 100), // Razorpay accepts amounts in paise
            currency: config?.CurrencyCode || "INR",
            receipt: transactionId
        };

        let rzpOrder: any;
        try {
            rzpOrder = await customRazorpay.orders.create(options);
        } catch (error) {
            throw razorpayOrderError(error, `appointment bill ${bill.AppointmentBillId}`);
        }

        // Store Pending payment record in database
        const payment = await paymentRepository.create({
            PaymentId: uuidv4(),
            AppointmentId: appointment ? appointment.Id : null,
            AppointmentBillId: bill.AppointmentBillId,
            PatientId: data.patientId,
            ProviderId: data.providerId || null,
            TransactionId: transactionId,
            Amount: chargeAmount,
            Currency: config?.CurrencyCode || "INR",
            PaymentGateway: config?.PaymentGateway || "Razorpay",
            GatewayOrderId: rzpOrder.id,
            Status: "Pending",
            TransactionDate: new Date()
        });

        // Write to payment audit log
        await paymentLogRepository.log(payment.PaymentId, "CREATE_ORDER", "Success", "Razorpay order generated", {
            orderId: rzpOrder.id
        });
        if (data.notify === false) {
            await paymentLogRepository.log(payment.PaymentId, NOTIFY_SUPPRESSED_EVENT, "Success", "Taken from billing; no confirmation messages are sent");
        }

        return {
            orderId: rzpOrder.id,
            key: rzpKeyId,
            transactionId: transactionId,
            billId: bill.AppointmentBillId,
            amount: chargeAmount,
            dueAmount
        };
    }

    /**
     * Finds the bill a payment belongs to: the bill the caller named, else the appointment's bill or,
     * for a follow-up visit, its root visit's bill. Legacy follow-up bills are folded in first so the
     * payment is checked against the same due amount the billing list shows.
     */
    private async resolveBill(data: { appointmentId?: number | null; billId?: string }): Promise<AppointmentBill | null> {
        const bill = (data.billId ? await appointmentBillRepository.findById(data.billId) : null)
            || (data.appointmentId ? await appointmentBillRepository.findBillForAppointment(Number(data.appointmentId)) : null);
        return bill ? await appointmentBillRepository.mergeBillGroup(bill.AppointmentBillId) : null;
    }

    /**
     * Moves a gateway payment to Success and credits its bill exactly once. The checkout callback and
     * the webhook can both arrive for the same order (or the callback can be retried); only the call
     * that performs the transition may add the amount to the bill.
     */
    private async markOnlinePaymentSuccess(payment: Payment, fields: Partial<Payment>) {
        let transitioned = false;
        let confirmedAppointment = false;

        await AppDataSource.transaction(async (manager) => {
            const result = await manager.createQueryBuilder().update(Payment)
                .set({ ...fields, Status: "Success", UpdatedAt: new Date() })
                .where("PaymentId = :id AND (Status IS NULL OR Status <> 'Success')", { id: payment.PaymentId })
                .execute();
            transitioned = (result.affected || 0) > 0;
            if (!transitioned) return;

            if (payment.AppointmentBillId) {
                const credited = await appointmentBillRepository.applyPayment(payment.AppointmentBillId, Number(payment.Amount), { rejectOverDue: false }, manager);
                if (!credited) {
                    console.error(`[PaymentService] Payment ${payment.PaymentId} succeeded but bill ${payment.AppointmentBillId} was not found to credit`);
                }
            }

            if (payment.AppointmentId) {
                const appt = await manager.findOne(Appointment, { where: { Id: payment.AppointmentId } });
                if (appt && isAwaitingConfirmation(appt.Status)) {
                    confirmedAppointment = true;
                    await manager.update("Appointments", appt.Id, {
                        Status: "Confirmed",
                        UpdatedAt: new Date()
                    });

                    // Book the doctor's schedule slot now that online payment is verified
                    if (appt.SlotId) {
                        await manager.update("HealthcareProviderScheduleSlots", appt.SlotId, {
                            IsBooked: true,
                            Status: "Booked",
                            UpdatedAt: new Date()
                        });
                        console.log(`[PaymentService] Slot #${appt.SlotId} successfully marked as Booked after payment confirmation for appointment #${appt.Id}`);
                    }
                }
            }
        });

        return { transitioned, confirmedAppointment };
    }

    /**
     * Verify payment signature from frontend and confirm the appointment.
     */
    async verifyPayment(data: {
        transactionId: string;
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
    }) {
        const payment = await paymentRepository.findByTransactionId(data.transactionId);
        if (!payment) throw new Error("Payment record not found.");

        // Verify with the keys its hospital's order was created with: the appointment's hospital, or the
        // bill's for a manual bill that has no appointment
        let config: HospitalPaymentConfiguration | null = null;
        let hospitalId: number | null = null;
        if (payment.AppointmentId) {
            const appointment = await appointmentRepository.findById(payment.AppointmentId);
            hospitalId = appointment?.HospitalId ?? null;
        }
        if (!hospitalId && payment.AppointmentBillId) {
            const bill = await appointmentBillRepository.findById(payment.AppointmentBillId);
            hospitalId = bill?.HospitalId ?? null;
        }
        if (hospitalId) {
            const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
            config = await configRepo.findOne({
                where: { HospitalId: hospitalId, IsDeleted: false }
            });
        }
        const { keySecret: rzpKeySecret } = resolveRazorpayKeys(config);

        // Compute HMAC signature to verify payment integrity using the correct keySecret
        const hmac = crypto.createHmac("sha256", rzpKeySecret);
        hmac.update(`${data.razorpay_order_id}|${data.razorpay_payment_id}`);
        const generatedSignature = hmac.digest("hex");

        if (generatedSignature !== data.razorpay_signature) {
            await paymentRepository.update(payment.PaymentId, {
                Status: "Failed",
                FailureReason: "Signature mismatch"
            });
            await paymentLogRepository.log(payment.PaymentId, "SIGNATURE_VERIFIED", "Failed", "Signature verification failed", {
                orderId: data.razorpay_order_id,
                paymentId: data.razorpay_payment_id
            });
            throw new Error("Payment verification failed.");
        }

        const { transitioned, confirmedAppointment } = await this.markOnlinePaymentSuccess(payment, {
            GatewayPaymentId: data.razorpay_payment_id,
            GatewaySignature: data.razorpay_signature,
            PaymentMethod: "Razorpay"
        });

        if (transitioned) {
            await paymentLogRepository.log(payment.PaymentId, "PAYMENT_SUCCESS", "Success", "Payment verified successfully", {
                orderId: data.razorpay_order_id,
                paymentId: data.razorpay_payment_id
            });
        }

        // Dispatch WhatsApp & push notifications ONLY after successful confirmation
        if (confirmedAppointment) {
            await this.sendConfirmationNotifications(payment, "post-verification");
        }

        return { success: true };
    }

    /** Sends the appointment confirmation messages for a payment, unless it was taken from billing. */
    private async sendConfirmationNotifications(payment: Payment, context: string) {
        if (!payment.AppointmentId) return;
        try {
            if (await paymentLogRepository.hasEvent(payment.PaymentId, NOTIFY_SUPPRESSED_EVENT)) return;
            const { mobileAppointmentService } = await import("../../MobileApi/v1/services/provider/mobile-appointment.service.js");
            await mobileAppointmentService.sendAppointmentConfirmationNotifications(payment.AppointmentId);
        } catch (notifyErr) {
            console.error(`[PaymentService] Error sending confirmation notifications ${context}:`, notifyErr);
        }
    }

    /**
     * Handle webhook callbacks from Razorpay dashboard to guarantee absolute order recovery.
     * Razorpay signs the exact bytes it sent, so the signature is checked against the raw body.
     */
    async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
        // An unverified event could mark any pending order paid, so without the secret nothing is accepted
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
            console.error("[Webhook] RAZORPAY_WEBHOOK_SECRET is not set; webhook rejected");
            return { success: false, error: "Webhook is not configured" };
        }
        if (!rawBody || !signature) {
            console.error("[Webhook] Unsigned webhook rejected");
            return { success: false, error: "Missing signature" };
        }
        const generatedSignature = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
        if (!signaturesMatch(generatedSignature, signature)) {
            console.error("[Webhook] Invalid signature received");
            return { success: false, error: "Invalid signature" };
        }

        const body = JSON.parse(rawBody.toString("utf8"));
        const event = body.event;
        const payload = body.payload;

        if (event === "payment.captured") {
            const orderId = payload.payment.entity.order_id;
            const paymentId = payload.payment.entity.id;
            const payment = await paymentRepository.findByGatewayOrderId(orderId);

            // Not an appointment payment: it may be a lab package order (kept in its own table)
            if (!payment) {
                const { labPackageOrderService } = await import("../LabPackages/lab-package-order.service.js");
                const handled = await labPackageOrderService.handleCaptured(orderId, paymentId, payload.payment.entity.method);
                if (handled) return { success: true };
            }

            if (payment && payment.Status !== "Success") {
                const { transitioned, confirmedAppointment } = await this.markOnlinePaymentSuccess(payment, {
                    GatewayPaymentId: paymentId,
                    PaymentMethod: payload.payment.entity.method
                });

                if (transitioned) {
                    await paymentLogRepository.log(payment.PaymentId, "WEBHOOK_RECOVERY", "Success", "Missed callback recovered successfully via webhook");
                }

                // Dispatch WhatsApp & push notifications ONLY after successful confirmation
                if (confirmedAppointment) {
                    await this.sendConfirmationNotifications(payment, "via webhook");
                }
            }
        }

        return { success: true };
    }

    /**
     * Process cash payment manually and confirm appointment
     */
    async collectManualCash(data: { appointmentId?: number | null; amount: number; patientId: string; providerId?: string; billId?: string; notify?: boolean }) {
        const amount = roundMoney(Number(data.amount));
        if (!(amount > 0)) throw new Error("Please enter a valid amount to collect.");
        const transactionId = `CASH_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;

        // Ensure AppointmentBill exists (a manual bill has no appointment, only the bill)
        const appointment = data.appointmentId ? await appointmentRepository.findById(data.appointmentId) : null;
        let bill = await this.resolveBill(data);
        if (!bill && !appointment) throw new Error("Bill not found.");
        if (!bill && appointment) {
            bill = await appointmentBillRepository.createBillWithItem({
                appointmentId: appointment.Id,
                patientId: data.patientId,
                providerId: data.providerId,
                hospitalId: appointment.HospitalId,
                consultationFee: amount,
                config: null
            });
        }

        let payment!: Payment;
        let confirmedAppointment = false;

        await AppDataSource.transaction(async (manager) => {
            // Credit the bill first: the conditional update refuses an amount above the due, which also
            // stops a double-submitted collection from being recorded twice
            if (bill) {
                const credited = await appointmentBillRepository.applyPayment(bill.AppointmentBillId, amount, { rejectOverDue: true }, manager);
                if (!credited) {
                    const current = await manager.findOne(AppointmentBill, { where: { AppointmentBillId: bill.AppointmentBillId } });
                    if (current?.BillStatus === "Cancelled") throw new Error("This bill is cancelled.");
                    const due = Math.max(0, roundMoney(Number(current?.TotalAmount) - Number(current?.PaidAmount)));
                    throw new Error(due > 0 ? `Amount ₹${amount} is more than the due amount ₹${due}.` : "This bill is already fully paid.");
                }
            }

            // Always a new record: a pending gateway order for this appointment is a separate online
            // attempt (it may still be paid) and keeps its own amount
            payment = await manager.save(Payment, manager.create(Payment, {
                PaymentId: uuidv4(),
                AppointmentId: appointment ? appointment.Id : null,
                AppointmentBillId: bill?.AppointmentBillId || null,
                PatientId: data.patientId,
                ProviderId: data.providerId || null,
                TransactionId: transactionId,
                Amount: amount,
                Currency: "INR",
                PaymentGateway: "Cash",
                PaymentMethod: "Cash",
                Status: "Success",
                TransactionDate: new Date()
            }));

            if (appointment && isAwaitingConfirmation(appointment.Status)) {
                confirmedAppointment = true;
                await manager.update("Appointments", appointment.Id, {
                    Status: "Confirmed",
                    UpdatedAt: new Date()
                });
            }
        });

        // Write to payment audit log
        await paymentLogRepository.log(payment.PaymentId, "CASH_PAYMENT", "Success", "Cash payment recorded successfully");

        if (confirmedAppointment) {
            try {
                if (appointment?.SlotId) {
                    await AppDataSource.getRepository("HealthcareProviderScheduleSlots").update(appointment.SlotId, {
                        IsBooked: true,
                        Status: "Booked",
                        UpdatedAt: new Date()
                    });
                }
                // Cash taken from the Billing page (notify: false) confirms the appointment without messages
                if (data.notify !== false) {
                    const { mobileAppointmentService } = await import("../../MobileApi/v1/services/provider/mobile-appointment.service.js");
                    await mobileAppointmentService.sendAppointmentConfirmationNotifications(appointment!.Id);
                }
            } catch (notifyErr) {
                console.error("[PaymentService] Error sending confirmation notifications post cash payment:", notifyErr);
            }
        }

        return { success: true, transactionId, billId: bill?.AppointmentBillId || null };
    }

    /**
     * Send payment link via Email, SMS, or WhatsApp selectively
     */
    async sendPaymentLink(data: { appointmentId: number; amount: number; patientId: string; clientUrl?: string; preferChannel?: "whatsapp" | "email" | "sms" }) {
        const user = await userRepository.findById(data.patientId);
        if (!user) throw new Error("Patient not found.");

        const paymentRepo = AppDataSource.getRepository(Payment);
        // Reuse an earlier link, never a gateway order, and keep its amount equal to the one in the message
        let payment = await paymentRepo.findOne({
            where: { AppointmentId: data.appointmentId, Status: "Pending", GatewayOrderId: IsNull() }
        });
        if (payment && roundMoney(Number(payment.Amount)) !== roundMoney(Number(data.amount))) {
            await paymentRepository.update(payment.PaymentId, { Amount: roundMoney(Number(data.amount)), UpdatedAt: new Date() });
        }

        let transactionId = payment?.TransactionId;
        if (!payment) {
            transactionId = `TXN_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;
            // Create pending payment record
            payment = await paymentRepository.create({
                PaymentId: uuidv4(),
                AppointmentId: data.appointmentId,
                PatientId: data.patientId,
                TransactionId: transactionId,
                Amount: data.amount,
                Currency: "INR",
                Status: "Pending",
                TransactionDate: new Date()
            });
        }

        const clientUrl = data.clientUrl || process.env.CLIENT_URL || "http://localhost:5173";
        const paymentLink = `${clientUrl}/pay/${transactionId}`;
        const preferChannel = data.preferChannel || "email";

        // Send Email if preferred and available
        if (preferChannel === "email" && user.Email) {
            try {
                const subject = "ClinicX - Complete Your Appointment Payment";
                const html = `
                    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; line-height: 1.6;">
                        <h2 style="color: #4f46e5;">ClinicX Appointment Booking</h2>
                        <p>Dear ${user.FirstName || "Patient"},</p>
                        <p>Thank you for scheduling your appointment. Please click the button below to securely complete your payment of <strong>₹${data.amount}</strong>.</p>
                        <div style="margin: 25px 0;">
                            <a href="${paymentLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Pay Securely Now</a>
                        </div>
                        <p>If the button doesn't work, copy and paste this link into your browser:</p>
                        <p style="color: #666; font-size: 12px;">${paymentLink}</p>
                        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                        <p style="font-size: 11px; color: #999;">This is an automated message. Please do not reply directly to this email.</p>
                    </div>
                `;
                await mailService.sendMail({ to: user.Email, subject, body: html });
                console.log(`[Payment link] Email sent to ${user.Email}`);
            } catch (emailErr: any) {
                console.error("[Payment Link] Failed to send email:", emailErr.message);
            }
        }

        // Send SMS if preferred and available
        if (preferChannel === "sms" && user.PhoneNumber) {
            try {
                const isIndia = user.PhoneNumber.startsWith("91") || (!user.PhoneNumber.startsWith("+") && user.CountryCode === "91");
                const normalizedPhone = user.PhoneNumber.startsWith("+") ? user.PhoneNumber : `+${user.CountryCode || "91"}${user.PhoneNumber}`;

                const message = `Dear ${user.FirstName || "Patient"}, complete your ClinicX payment of Rs.${data.amount} here: ${paymentLink}`;
                await smsService.sendSMS(normalizedPhone, message);
                console.log(`[Payment link] SMS sent to ${user.PhoneNumber}`);
            } catch (smsErr: any) {
                console.error("[Payment Link] Failed to send SMS:", smsErr.message);
            }
        }

        // Generate WhatsApp Link
        const rawPhone = user.PhoneNumber || "";
        const cleanPhone = rawPhone.replace(/\D/g, "");
        const formattedPhone = cleanPhone.startsWith(user.CountryCode || "91")
            ? cleanPhone
            : `${user.CountryCode || "91"}${cleanPhone}`;
        const whatsappText = `Dear ${user.FirstName || "Patient"}, complete your ClinicX payment of Rs.${data.amount} here: ${paymentLink}`;
        const whatsappLink = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(whatsappText)}`;

        await paymentLogRepository.log(payment.PaymentId, "SEND_PAYMENT_LINK", "Success", `Payment link sent to patient via ${preferChannel}`);

        return { success: true, paymentLink, whatsappLink };
    }


    /**
     * Look up payment details by Transaction ID
     */
    async lookupTransaction(transactionId: string) {
        const paymentRepo = AppDataSource.getRepository(Payment);
        const payment = await paymentRepo.findOne({
            where: { TransactionId: transactionId }
        });

        if (!payment) throw new Error("Transaction not found.");

        const user = await userRepository.findById(payment.PatientId);
        const appointmentRepo = AppDataSource.getRepository(Appointment);
        const appointment = await appointmentRepo.findOne({
            where: { Id: (payment.AppointmentId as any) }
        });

        let providerName = "Consulting Doctor";
        if (appointment?.DoctorId) {
            const provider = await userRepository.findById(appointment.DoctorId);
            if (provider) {
                providerName = `Dr. ${provider.FirstName} ${provider.LastName}`;
            }
        }

        return {
            transactionId: payment.TransactionId,
            appointmentId: payment.AppointmentId,
            patientId: payment.PatientId,
            amount: payment.Amount,
            status: payment.Status,
            patientName: user ? `${user.FirstName} ${user.LastName}` : "Patient",
            providerName,
            date: appointment?.AppointmentDate || new Date().toISOString().split("T")[0]
        };
    }

    async getBillsList(filters: {
        orgId?: number;
        hospitalId?: number;
        providerId?: string;
        patientId?: string;
        billStatus?: string;
        startDate?: string;
        endDate?: string;
        search?: string;
        page?: number;
        limit?: number;
    }) {
        const { data, total, totalCollected, totalPending } = await appointmentBillRepository.getBillsList(filters);

        const { Payment } = await import("../../models/Payments/payment.model.js");
        const payRepo = AppDataSource.getRepository(Payment);

        const { HospitalPaymentConfiguration } = await import("../../models/Organizations/hospital-payment-configuration.model.js");
        const { In } = await import("typeorm/index.js");
        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);

        const hospitalIds = Array.from(new Set(data.map(b => b.HospitalId).filter(Boolean)));
        const configs = hospitalIds.length > 0 ? await configRepo.find({ where: { HospitalId: In(hospitalIds), IsDeleted: false } }) : [];
        const configMap = new Map<number, any>(configs.map(c => [c.HospitalId, c]));

        const formatted = await Promise.all(data.map(async (b) => {
            const provider = b.Provider || b.Appointment?.Doctor;
            const config = b.HospitalId ? configMap.get(b.HospitalId) : null;
            const hospitalGstIn = config?.GstNumber || (b.Hospital as any)?.GstNumber || null;

            // Find latest payment record linked to this bill or appointment
            let paymentMethod: string | null = null;
            let paymentGateway: string | null = null;
            let transactionId: string | null = null;
            let paymentMethods: string[] = [];

            try {
                const payRecords = await payRepo.find({
                    where: [
                        { AppointmentBillId: b.AppointmentBillId },
                        ...(b.AppointmentId ? [{ AppointmentId: b.AppointmentId }] : [])
                    ],
                    order: { CreatedAt: "DESC" }
                });

                // Abandoned or failed gateway orders are not payments; a split bill lists every method used
                const successPays = payRecords.filter(p => p.Status === "Success");
                paymentMethods = Array.from(new Set(successPays.map(p => p.PaymentMethod || p.PaymentGateway).filter(Boolean) as string[]));
                const successPay = successPays[0];
                if (successPay) {
                    paymentMethod = successPay.PaymentMethod || successPay.PaymentGateway || (Number(b.PaidAmount) > 0 ? "Cash" : null);
                    paymentGateway = successPay.PaymentGateway || null;
                    transactionId = successPay.TransactionId || null;
                }
            } catch {
                // ignore
            }

            if (!paymentMethod && Number(b.PaidAmount) > 0) {
                paymentMethod = "Cash";
            }

            return {
                billId: b.AppointmentBillId,
                billNumber: b.BillNumber,
                billType: b.BillType,
                billStatus: b.BillStatus,
                subTotal: Number(b.SubTotal || 0),
                discountAmount: Number(b.DiscountAmount || 0),
                gstAmount: Number(b.GstAmount || 0),
                cgstAmount: Number(b.CgstAmount || 0),
                sgstAmount: Number(b.SgstAmount || 0),
                igstAmount: Number(b.IgstAmount || 0),
                gstPercentage: config?.GstPercentage !== undefined ? Number(config.GstPercentage) : 0,
                cgstPercentage: config?.CgstPercentage !== undefined ? Number(config.CgstPercentage) : 0,
                sgstPercentage: config?.SgstPercentage !== undefined ? Number(config.SgstPercentage) : 0,
                igstPercentage: config?.IgstPercentage !== undefined ? Number(config.IgstPercentage) : 0,
                hospitalGstIn: hospitalGstIn,
                totalAmount: Number(b.TotalAmount || 0),
                paidAmount: Number(b.PaidAmount || 0),
                dueAmount: Number(b.DueAmount || 0),
                createdAt: b.CreatedAt,
                appointmentId: b.AppointmentId,
                appointmentDate: b.Appointment?.AppointmentDate || null,
                hospitalId: b.HospitalId,
                hospitalName: (b as any).Hospital?.Name || "—",
                orgName: (b.Appointment as any)?.Organization?.Name || "—",
                patientId: b.PatientId,
                patientName: b.Patient ? `${b.Patient.FirstName} ${b.Patient.LastName}` : "—",
                patientPhone: b.Patient?.PhoneNumber || "—",
                providerId: provider?.Id || null,
                providerName: provider ? `Dr. ${provider.FirstName} ${provider.LastName}` : "—",
                notes: b.Notes || "",
                appointmentChain: (b as any).appointmentChain || [],
                paymentMethod: paymentMethod || (Number(b.PaidAmount) > 0 ? "Cash" : null),
                paymentMethods,
                paymentGateway: paymentGateway || (paymentMethod === "Razorpay" ? "Razorpay" : null),
                transactionId: transactionId || null,
                items: (b.BillItems || []).map(i => ({
                    itemName: i.ItemName,
                    itemType: i.ItemType,
                    unitPrice: Number(i.UnitPrice || 0),
                    quantity: Number(i.Quantity || 1),
                    discountAmount: Number(i.DiscountAmount || 0),
                    gstPercentage: Number(i.GstPercentage || 0),
                    gstAmount: Number(i.GstAmount || 0),
                    totalAmount: Number(i.TotalAmount || 0),
                    appointmentId: i.AppointmentId || null,
                    itemReferenceId: i.ItemReferenceId || null
                }))
            };
        }));

        return {
            data: formatted,
            total,
            totalCollected,
            totalPending,
            page: filters.page || 1,
            limit: filters.limit || 20,
            totalPages: Math.ceil(total / (filters.limit || 20))
        };
    }

    async getBillingList(filters: {
        orgId?: number;
        hospitalId?: number;
        providerId?: string;
        status?: string;
        startDate?: string;
        endDate?: string;
        page?: number;
        limit?: number;
        search?: string;
    }) {
        const { data, total, totalAmount } = await paymentRepository.getBillingList(filters);

        const formatted = data.map(p => ({
            paymentId: p.PaymentId,
            transactionId: p.TransactionId,
            receiptNumber: p.ReceiptNumber,
            amount: p.Amount,
            currency: p.Currency,
            status: p.Status,
            paymentMethod: p.PaymentMethod,
            paymentGateway: p.PaymentGateway,
            transactionDate: p.TransactionDate,
            createdAt: p.CreatedAt,
            patientId: p.PatientId,
            patientName: p.Patient ? `${p.Patient.FirstName} ${p.Patient.LastName}` : "—",
            patientPhone: p.Patient?.PhoneNumber || "—",
            providerId: p.ProviderId,
            providerName: p.Provider ? `Dr. ${p.Provider.FirstName} ${p.Provider.LastName}` : "—",
            appointmentId: p.AppointmentId,
            appointmentDate: p.Appointment?.AppointmentDate || null,
            hospitalId: p.Appointment?.HospitalId || null,
            hospitalName: (p.Appointment as any)?.Hospital?.Name || "—",
            orgId: p.Appointment?.OrgId || null,
            orgName: (p.Appointment as any)?.Organization?.Name || "—",
            failureReason: p.FailureReason,
            // Bill details
            billId: p.AppointmentBillId,
            billNumber: (p as any).AppointmentBill?.BillNumber || null,
            billStatus: (p as any).AppointmentBill?.BillStatus || null,
            billTotal: (p as any).AppointmentBill?.TotalAmount || null,
            billPaid: (p as any).AppointmentBill?.PaidAmount || null,
            billDue: (p as any).AppointmentBill?.DueAmount || null,
        }));

        return {
            data: formatted,
            total,
            totalAmount,
            totalPages: Math.ceil(total / (filters.limit || 50))
        };
    }

    async getPaymentDetail(paymentId: string) {
        const p = await paymentRepository.findById(paymentId);
        if (!p) throw new Error("Payment record not found.");

        return {
            paymentId: p.PaymentId,
            transactionId: p.TransactionId,
            receiptNumber: p.ReceiptNumber,
            amount: p.Amount,
            currency: p.Currency,
            status: p.Status,
            paymentMethod: p.PaymentMethod,
            paymentGateway: p.PaymentGateway,
            transactionDate: p.TransactionDate,
            createdAt: p.CreatedAt,
            patientId: p.PatientId,
            patientName: p.Patient ? `${p.Patient.FirstName} ${p.Patient.LastName}` : "—",
            patientPhone: p.Patient?.PhoneNumber || "—",
            providerId: p.ProviderId,
            providerName: p.Provider ? `Dr. ${p.Provider.FirstName} ${p.Provider.LastName}` : "—",
            appointmentId: p.AppointmentId,
            appointmentDate: p.Appointment?.AppointmentDate || null,
            hospitalId: p.Appointment?.HospitalId || null,
            hospitalName: (p.Appointment as any)?.Hospital?.Name || "—",
            orgId: p.Appointment?.OrgId || null,
            orgName: (p.Appointment as any)?.Organization?.Name || "—",
            failureReason: p.FailureReason
        };
    }

    async getPaymentByAppointment(appointmentId: number) {
        const payment = await paymentRepository.findByAppointmentId(appointmentId);

        // The bill is looked up on its own: the latest payment may be a payment-link record with no bill,
        // and a follow-up visit's charges sit on its root visit's bill
        let bill: AppointmentBill | null = null;
        try {
            bill = await appointmentBillRepository.findBillForAppointment(appointmentId);
        } catch (err) {
            console.error("Error fetching bill by appointment:", err);
        }
        const billFields = {
            billId: bill?.AppointmentBillId || null,
            billStatus: bill?.BillStatus || null,
            billTotal: bill ? Number(bill.TotalAmount || 0) : null,
            billPaid: bill ? Number(bill.PaidAmount || 0) : null,
            billDue: bill ? Number(bill.DueAmount || 0) : null
        };

        if (!payment) {
            if (!bill) return null;
            const appointment = await appointmentRepository.findById(appointmentId);
            return {
                paymentId: null,
                transactionId: null,
                receiptNumber: bill.BillNumber,
                amount: Number(bill.TotalAmount || 0),
                currency: "INR",
                status: bill.BillStatus === "Paid" ? "Success" : "Pending",
                paymentMethod: "—",
                paymentGateway: "—",
                transactionDate: null,
                createdAt: bill.CreatedAt,
                patientId: bill.PatientId,
                patientName: bill.Patient ? `${bill.Patient.FirstName} ${bill.Patient.LastName}`.trim() : "—",
                patientPhone: bill.Patient?.PhoneNumber || "—",
                providerId: bill.ProviderId,
                providerName: bill.Provider ? `Dr. ${bill.Provider.FirstName} ${bill.Provider.LastName}` : "—",
                appointmentId,
                appointmentDate: appointment?.AppointmentDate || null,
                ...billFields,
                failureReason: null
            };
        }

        return {
            paymentId: payment.PaymentId,
            transactionId: payment.TransactionId,
            receiptNumber: payment.ReceiptNumber,
            amount: payment.Amount,
            currency: payment.Currency,
            status: payment.Status,
            paymentMethod: payment.PaymentMethod,
            paymentGateway: payment.PaymentGateway,
            transactionDate: payment.TransactionDate,
            createdAt: payment.CreatedAt,
            patientId: payment.PatientId,
            patientName: payment.Patient ? `${payment.Patient.FirstName} ${payment.Patient.LastName}` : "—",
            patientPhone: payment.Patient?.PhoneNumber || "—",
            providerId: payment.ProviderId,
            providerName: payment.Provider ? `Dr. ${payment.Provider.FirstName} ${payment.Provider.LastName}` : "—",
            appointmentId: payment.AppointmentId,
            appointmentDate: payment.Appointment?.AppointmentDate || null,
            ...billFields,
            failureReason: payment.FailureReason
        };
    }

    async getHospitalPaymentConfiguration(hospitalId: number) {
        const repo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        let config = await repo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });
        if (!config) {
            // Return defaults if none configured
            return {
                HospitalId: hospitalId,
                PaymentGateway: "razorpay",
                RazorpayKeyId: "",
                HasRazorpayKeySecret: false,
                GstPercentage: 0,
                CgstPercentage: 0,
                SgstPercentage: 0,
                IgstPercentage: 0,
                GstNumber: "",
                InvoicePrefix: "INV",
                InvoiceSequence: 1,
                CurrencyCode: "INR",
                IsActive: true
            };
        }
        return withoutKeySecret(config);
    }

    async saveHospitalPaymentConfiguration(data: any) {
        const repo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const hospitalId = parseInt(data.hospitalId || data.HospitalId);
        if (!hospitalId) throw new Error("Hospital ID is required.");

        let config = await repo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });

        if (!config) {
            config = new HospitalPaymentConfiguration();
            config.HospitalPaymentConfigurationId = uuidv4();
            config.HospitalId = hospitalId;
        }

        config.PaymentGateway = data.paymentGateway || data.PaymentGateway || "razorpay";
        const previousKeyId = config.RazorpayKeyId;
        config.RazorpayKeyId = data.razorpayKeyId !== undefined ? data.razorpayKeyId : data.RazorpayKeyId;
        // The page is never sent the saved secret, so an empty value keeps it
        const newKeySecret = data.razorpayKeySecret !== undefined ? data.razorpayKeySecret : data.RazorpayKeySecret;
        if (typeof config.RazorpayKeyId === "string") config.RazorpayKeyId = config.RazorpayKeyId.trim();
        if (newKeySecret) {
            config.RazorpayKeySecret = String(newKeySecret).trim();
        } else if (config.RazorpayKeySecret && config.RazorpayKeyId && config.RazorpayKeyId !== previousKeyId) {
            throw new Error("Enter the Razorpay key secret for the new key ID.");
        }
        // New keys are tried against Razorpay first, so dead keys can't be saved and fail at checkout.
        if (config.RazorpayKeyId && config.RazorpayKeySecret && (newKeySecret || config.RazorpayKeyId !== previousKeyId)) {
            const problem = await razorpayKeyProblem(config.RazorpayKeyId, config.RazorpayKeySecret);
            if (problem) throw new Error(problem);
        }
        config.GstPercentage = parseFloat(data.gstPercentage || data.GstPercentage || 0);
        config.CgstPercentage = parseFloat(data.cgstPercentage || data.CgstPercentage || 0);
        config.SgstPercentage = parseFloat(data.sgstPercentage || data.SgstPercentage || 0);
        config.IgstPercentage = parseFloat(data.igstPercentage || data.IgstPercentage || 0);
        config.GstNumber = data.gstNumber !== undefined ? data.gstNumber : data.GstNumber;
        config.InvoicePrefix = data.invoicePrefix || data.InvoicePrefix || "INV";
        config.InvoiceSequence = parseInt(data.invoiceSequence || data.InvoiceSequence || 1);
        config.CurrencyCode = data.currencyCode || data.CurrencyCode || "INR";
        config.IsActive = data.isActive !== undefined ? !!data.isActive : (config.IsActive !== undefined ? config.IsActive : true);
        config.UpdatedAt = new Date();

        return withoutKeySecret(await repo.save(config));
    }

    async updateBillDetails(
        billId: string,
        data: {
            items: {
                itemId?: string;
                itemName: string;
                itemType: string;
                unitPrice: number;
                quantity: number;
                discountAmount: number;
                gstPercentage?: number;
                appointmentId?: string | number | null;
                itemReferenceId?: string | null;
            }[];
            discountAmount: number;
            notes?: string;
            gstPercentage?: number;
            gstAmount?: number;
        }
    ) {
        return await appointmentBillRepository.updateBillDetails(billId, data);
    }

    async generateInvoice(billId: string) {
        return await appointmentBillRepository.generateInvoice(billId);
    }

    /** A bill for a patient with no appointment, added on the billing page. It sends no messages. */
    async createManualBill(data: {
        patientId: string;
        hospitalId: number | string;
        providerId?: string | null;
        items: {
            itemName: string;
            itemType: string;
            unitPrice: number;
            quantity: number;
            discountAmount: number;
            gstPercentage?: number;
            itemReferenceId?: string | null;
        }[];
        discountAmount?: number;
        notes?: string;
        gstPercentage?: number;
    }) {
        if (!data.patientId) throw new Error("Select a patient for the bill.");
        const hospitalId = Number(data.hospitalId);
        if (!(hospitalId > 0)) throw new Error("Hospital is required.");
        const patient = await userRepository.findById(data.patientId);
        if (!patient) throw new Error("Patient not found.");

        return await appointmentBillRepository.createManualBill({
            patientId: patient.Id,
            hospitalId,
            providerId: data.providerId || null,
            items: data.items,
            discountAmount: Number(data.discountAmount) || 0,
            notes: data.notes,
            gstPercentage: data.gstPercentage
        });
    }

}


export const paymentService = new PaymentService();
