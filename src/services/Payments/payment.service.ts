import Razorpay from "razorpay";
import crypto from "crypto";
import { paymentRepository } from "../../repositories/Payments/payment.repository.js";
import { paymentLogRepository } from "../../repositories/Payments/payment-log.repository.js";
import { appointmentRepository } from "../../repositories/Appointments/appointment.repository.js";
import { appointmentBillRepository } from "../../repositories/Payments/appointment-bill.repository.js";
import { AppDataSource } from "../../config/database.js";
import { v4 as uuidv4 } from "uuid";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { mailService } from "../Mail/mail.service.js";
import { smsService } from "../Common/sms.service.js";
import { Payment } from "../../models/Payments/payment.model.js";
import { Appointment } from "../../models/Appointments/appointment.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";



// Initialize Razorpay SDK using credentials from environment variables
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_SpavktGuBgFo64",
    key_secret: process.env.RAZORPAY_KEY_SECRET || "kvzLdILyyKMZfTbeCJQo32ip"
});

export class PaymentService {
    /**
     * Create a Razorpay order and generate a pending Payment record.
     */
    async createOrder(data: { appointmentId: number; patientId: string; amount: number; providerId?: string }) {
        const transactionId = `TXN_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;

        // Get appointment to find its hospitalId
        const appointment = await appointmentRepository.findById(data.appointmentId);
        if (!appointment) throw new Error("Appointment not found.");
        const hospitalId = appointment.HospitalId;

        // Retrieve hospital-scoped payment configurations
        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const config = await configRepo.findOne({
            where: { HospitalId: hospitalId, IsDeleted: false }
        });

        // Initialize Razorpay custom credentials if configured, otherwise fall back to environment variables
        let rzpKeyId = process.env.RAZORPAY_KEY_ID || "rzp_test_SpavktGuBgFo64";
        let rzpKeySecret = process.env.RAZORPAY_KEY_SECRET || "kvzLdILyyKMZfTbeCJQo32ip";

        if (config && config.RazorpayKeyId && config.RazorpayKeySecret) {
            rzpKeyId = config.RazorpayKeyId;
            rzpKeySecret = config.RazorpayKeySecret;
        }

        const customRazorpay = new Razorpay({
            key_id: rzpKeyId,
            key_secret: rzpKeySecret
        });

        // Ensure AppointmentBill exists — create if not
        let bill = await appointmentBillRepository.findByAppointmentId(data.appointmentId);
        if (!bill) {
            bill = await appointmentBillRepository.createBillWithItem({
                appointmentId: data.appointmentId,
                patientId: data.patientId,
                providerId: data.providerId,
                hospitalId,
                consultationFee: Number(data.amount),
                config
            });
        }

        if (bill.BillStatus === "Draft") {
            throw new Error("Please generate the invoice before initiating online payment.");
        }

        // Use bill's DueAmount as the actual charge amount
        const chargeAmount = Number(bill.DueAmount) > 0 ? Number(bill.DueAmount) : data.amount;

        // Call Razorpay API to generate order
        const options = {
            amount: Math.round(chargeAmount * 100), // Razorpay accepts amounts in paise
            currency: config?.CurrencyCode || "INR",
            receipt: transactionId
        };

        const rzpOrder = await customRazorpay.orders.create(options);

        // Store Pending payment record in database
        const payment = await paymentRepository.create({
            PaymentId: uuidv4(),
            AppointmentId: data.appointmentId,
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

        return {
            orderId: rzpOrder.id,
            key: rzpKeyId,
            transactionId: transactionId,
            billId: bill.AppointmentBillId,
            amount: chargeAmount
        };
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

        let rzpKeySecret = process.env.RAZORPAY_KEY_SECRET || "kvzLdILyyKMZfTbeCJQo32ip";

        // If the payment is linked to an appointment, we query its hospital configuration
        if (payment.AppointmentId) {
            const appointment = await appointmentRepository.findById(payment.AppointmentId);
            if (appointment) {
                const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
                const config = await configRepo.findOne({
                    where: { HospitalId: appointment.HospitalId, IsDeleted: false }
                });
                if (config && config.RazorpayKeySecret) {
                    rzpKeySecret = config.RazorpayKeySecret;
                }
            }
        }

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

        // Complete the payment & transition appointment to Confirmed in a secure transaction block
        await AppDataSource.transaction(async (manager) => {
            await manager.update("Payments", payment.PaymentId, {
                Status: "Success",
                GatewayPaymentId: data.razorpay_payment_id,
                GatewaySignature: data.razorpay_signature,
                PaymentMethod: "Razorpay",
                UpdatedAt: new Date()
            });

            await manager.update("Appointments", payment.AppointmentId!, {
                Status: "Confirmed",
                UpdatedAt: new Date()
            });
        });

        // Update AppointmentBill — only on success
        if (payment.AppointmentBillId) {
            await appointmentBillRepository.updateBillOnPaymentSuccess(payment.AppointmentBillId, Number(payment.Amount));
        }

        await paymentLogRepository.log(payment.PaymentId, "PAYMENT_SUCCESS", "Success", "Payment verified successfully", {
            orderId: data.razorpay_order_id,
            paymentId: data.razorpay_payment_id
        });

        return { success: true };
    }

    /**
     * Handle webhook callbacks from Razorpay dashboard to guarantee absolute order recovery.
     */
    async handleWebhook(body: any, signature: string) {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        if (webhookSecret && signature) {
            const hmac = crypto.createHmac("sha256", webhookSecret);
            hmac.update(JSON.stringify(body));
            const generatedSignature = hmac.digest("hex");
            if (generatedSignature !== signature) {
                console.error("[Webhook] Invalid signature received");
                return { success: false, error: "Invalid signature" };
            }
        }

        const event = body.event;
        const payload = body.payload;

        if (event === "payment.captured") {
            const orderId = payload.payment.entity.order_id;
            const paymentId = payload.payment.entity.id;
            const payment = await paymentRepository.findByGatewayOrderId(orderId);

            if (payment && payment.Status !== "Success") {
                await AppDataSource.transaction(async (manager) => {
                    await manager.update("Payments", payment.PaymentId, {
                        Status: "Success",
                        GatewayPaymentId: paymentId,
                        PaymentMethod: payload.payment.entity.method,
                        UpdatedAt: new Date()
                    });

                    await manager.update("Appointments", payment.AppointmentId!, {
                        Status: "Confirmed",
                        UpdatedAt: new Date()
                    });
                });

                // Update AppointmentBill on webhook recovery
                if (payment.AppointmentBillId) {
                    await appointmentBillRepository.updateBillOnPaymentSuccess(payment.AppointmentBillId, Number(payment.Amount));
                }

                await paymentLogRepository.log(payment.PaymentId, "WEBHOOK_RECOVERY", "Success", "Missed callback recovered successfully via webhook");
            }
        }

        return { success: true };
    }

    /**
     * Process cash payment manually and confirm appointment
     */
    async collectManualCash(data: { appointmentId: number; amount: number; patientId: string; providerId?: string }) {
        const transactionId = `CASH_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;

        // Ensure AppointmentBill exists
        const appointment = await appointmentRepository.findById(data.appointmentId);
        let bill = await appointmentBillRepository.findByAppointmentId(data.appointmentId);
        if (!bill && appointment) {
            bill = await appointmentBillRepository.createBillWithItem({
                appointmentId: data.appointmentId,
                patientId: data.patientId,
                providerId: data.providerId,
                hospitalId: appointment.HospitalId,
                consultationFee: Number(data.amount),
                config: null
            });
        } else if (bill && bill.BillStatus === "Pending" && Number(bill.SubTotal) !== Number(data.amount)) {
            bill = await appointmentBillRepository.updateBillBaseAmount(bill.AppointmentBillId, Number(data.amount), null);
        }

        const paymentRepo = AppDataSource.getRepository(Payment);
        let payment = await paymentRepo.findOne({
            where: { AppointmentId: data.appointmentId, Status: "Pending" }
        });

        if (payment) {
            // Update existing pending payment to Success
            await AppDataSource.transaction(async (manager) => {
                await manager.update("Payments", payment!.PaymentId, {
                    Status: "Success",
                    PaymentGateway: "Cash",
                    PaymentMethod: "Cash",
                    TransactionId: transactionId,
                    UpdatedAt: new Date()
                });
                await manager.update("Appointments", data.appointmentId, {
                    Status: "Confirmed",
                    UpdatedAt: new Date()
                });
            });
        } else {
            // Create a new Cash payment
            payment = await paymentRepository.create({
                PaymentId: uuidv4(),
                AppointmentId: data.appointmentId,
                AppointmentBillId: bill?.AppointmentBillId || null,
                PatientId: data.patientId,
                ProviderId: data.providerId || null,
                TransactionId: transactionId,
                Amount: data.amount,
                Currency: "INR",
                PaymentGateway: "Cash",
                PaymentMethod: "Cash",
                Status: "Success",
                TransactionDate: new Date()
            });

            await AppDataSource.transaction(async (manager) => {
                await manager.update("Appointments", data.appointmentId, {
                    Status: "Confirmed",
                    UpdatedAt: new Date()
                });
            });
        }

        // Update AppointmentBill
        if (bill) {
            await appointmentBillRepository.updateBillOnPaymentSuccess(bill.AppointmentBillId, data.amount);
        }

        // Write to payment audit log
        await paymentLogRepository.log(payment.PaymentId, "CASH_PAYMENT", "Success", "Cash payment recorded successfully");

        return { success: true, transactionId };
    }

    /**
     * Send payment link via Email, SMS, or WhatsApp selectively
     */
    async sendPaymentLink(data: { appointmentId: number; amount: number; patientId: string; clientUrl?: string; preferChannel?: "whatsapp" | "email" | "sms" }) {
        const user = await userRepository.findById(data.patientId);
        if (!user) throw new Error("Patient not found.");

        const paymentRepo = AppDataSource.getRepository(Payment);
        let payment = await paymentRepo.findOne({
            where: { AppointmentId: data.appointmentId, Status: "Pending" }
        });

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

        const formatted = data.map(b => {
            const provider = b.Provider || b.Appointment?.Doctor;
            return {
                billId: b.AppointmentBillId,
                billNumber: b.BillNumber,
                billType: b.BillType,
                billStatus: b.BillStatus,
                subTotal: b.SubTotal,
                discountAmount: b.DiscountAmount,
                gstAmount: b.GstAmount,
                totalAmount: b.TotalAmount,
                paidAmount: b.PaidAmount,
                dueAmount: b.DueAmount,
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
                items: (b.BillItems || []).map(i => ({
                    itemName: i.ItemName,
                    itemType: i.ItemType,
                    unitPrice: i.UnitPrice,
                    quantity: i.Quantity,
                    discountAmount: i.DiscountAmount || 0,
                    totalAmount: i.TotalAmount,
                    appointmentId: i.AppointmentId || null
                }))
            };
        });

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
        if (!payment) return null;

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
            billStatus: payment.AppointmentBill?.BillStatus || null,
            billTotal: payment.AppointmentBill?.TotalAmount || null,
            billPaid: payment.AppointmentBill?.PaidAmount || null,
            billDue: payment.AppointmentBill?.DueAmount || null,
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
                RazorpayKeySecret: "",
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
        return config;
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
        config.RazorpayKeyId = data.razorpayKeyId !== undefined ? data.razorpayKeyId : data.RazorpayKeyId;
        config.RazorpayKeySecret = data.razorpayKeySecret !== undefined ? data.razorpayKeySecret : data.RazorpayKeySecret;
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

        return await repo.save(config);
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

}


export const paymentService = new PaymentService();
