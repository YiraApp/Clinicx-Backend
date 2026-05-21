import { AppDataSource } from "../../config/database.js";
import { Payment } from "../../models/Payments/payment.model.js";
import { Between, FindOptionsWhere } from "typeorm/index.js";

export class PaymentRepository {
    private repo = AppDataSource.getRepository(Payment);

    async create(data: Partial<Payment>): Promise<Payment> {
        const payment = this.repo.create(data);
        return await this.repo.save(payment);
    }

    async findById(id: string): Promise<Payment | null> {
        return await this.repo.findOne({
            where: { PaymentId: id },
            relations: ["Patient", "Provider", "Appointment"]
        });
    }

    async findByTransactionId(transactionId: string): Promise<Payment | null> {
        return await this.repo.findOne({
            where: { TransactionId: transactionId },
            relations: ["Patient", "Provider", "Appointment"]
        });
    }

    async findByGatewayOrderId(orderId: string): Promise<Payment | null> {
        return await this.repo.findOne({
            where: { GatewayOrderId: orderId },
            relations: ["Patient", "Provider", "Appointment"]
        });
    }

    async update(id: string, data: Partial<Payment>): Promise<void> {
        await this.repo.update(id, data);
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
    }): Promise<{ data: Payment[]; total: number; totalAmount: number }> {
        const { orgId, hospitalId, providerId, status, startDate, endDate, page = 1, limit = 50, search } = filters;

        const qb = this.repo.createQueryBuilder("p")
            .leftJoinAndSelect("p.Patient", "patient")
            .leftJoinAndSelect("p.Provider", "provider")
            .leftJoinAndSelect("p.Appointment", "appointment")
            .leftJoinAndSelect("appointment.Organization", "org")
            .leftJoinAndSelect("appointment.Hospital", "hospital")
            .leftJoinAndSelect("p.AppointmentBill", "bill")
            .where("p.IsDeleted = :deleted", { deleted: false });

        if (orgId) {
            qb.andWhere("appointment.OrgId = :orgId", { orgId });
        }
        if (hospitalId) {
            qb.andWhere("appointment.HospitalId = :hospitalId", { hospitalId });
        }
        if (providerId) {
            qb.andWhere("p.ProviderId = :providerId", { providerId });
        }
        if (status) {
            qb.andWhere("p.Status = :status", { status });
        }
        if (startDate) {
            qb.andWhere("p.CreatedAt >= :startDate", { startDate: new Date(startDate) });
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            qb.andWhere("p.CreatedAt <= :endDate", { endDate: end });
        }
        if (search) {
            qb.andWhere(
                "(p.TransactionId LIKE :search OR p.ReceiptNumber LIKE :search OR patient.FirstName LIKE :search OR patient.LastName LIKE :search OR patient.PhoneNumber LIKE :search)",
                { search: `%${search}%` }
            );
        }

        qb.orderBy("p.CreatedAt", "DESC")
          .skip((page - 1) * limit)
          .take(limit);

        const [data, total] = await qb.getManyAndCount();

        // Calculate total amount for successful payments in this filter
        const amountQb = this.repo.createQueryBuilder("p")
            .leftJoin("p.Appointment", "appointment")
            .leftJoin("p.Patient", "patient")
            .select("SUM(p.Amount)", "total")
            .where("p.IsDeleted = :deleted", { deleted: false })
            .andWhere("p.Status = :status", { status: "Success" });

        if (orgId) amountQb.andWhere("appointment.OrgId = :orgId", { orgId });
        if (hospitalId) amountQb.andWhere("appointment.HospitalId = :hospitalId", { hospitalId });
        if (providerId) amountQb.andWhere("p.ProviderId = :providerId", { providerId });
        if (startDate) amountQb.andWhere("p.CreatedAt >= :startDate", { startDate: new Date(startDate) });
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            amountQb.andWhere("p.CreatedAt <= :endDate", { endDate: end });
        }
        if (search) {
            amountQb.andWhere(
                "(p.TransactionId LIKE :search OR p.ReceiptNumber LIKE :search OR patient.FirstName LIKE :search OR patient.LastName LIKE :search OR patient.PhoneNumber LIKE :search)",
                { search: `%${search}%` }
            );
        }

        const amountResult = await amountQb.getRawOne();
        const totalAmount = parseFloat(amountResult?.total || "0");

        return { data, total, totalAmount };
    }
}

export const paymentRepository = new PaymentRepository();
