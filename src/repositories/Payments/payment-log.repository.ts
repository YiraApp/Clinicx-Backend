import { AppDataSource } from "../../config/database.js";
import { PaymentLog } from "../../models/Payments/payment-log.model.js";
import { v4 as uuidv4 } from "uuid";

export class PaymentLogRepository {
    private repo = AppDataSource.getRepository(PaymentLog);

    async log(paymentId: string, eventType: string, status: string, message?: string, extra?: { orderId?: string, paymentId?: string }): Promise<PaymentLog> {
        const logEntry = this.repo.create({
            PaymentLogId: uuidv4(),
            PaymentId: paymentId,
            EventType: eventType,
            Status: status,
            Message: message,
            GatewayOrderId: extra?.orderId || null,
            GatewayPaymentId: extra?.paymentId || null,
            LoggedAt: new Date()
        });
        return await this.repo.save(logEntry);
    }
}

export const paymentLogRepository = new PaymentLogRepository();
