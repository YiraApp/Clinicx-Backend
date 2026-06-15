import { AppDataSource } from "../../config/database.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { AppointmentBillItem } from "../../models/Payments/appointment-bill-item.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { v4 as uuidv4 } from "uuid";

export class AppointmentBillRepository {
    private repo = AppDataSource.getRepository(AppointmentBill);
    private itemRepo = AppDataSource.getRepository(AppointmentBillItem);

    async findByAppointmentId(appointmentId: number): Promise<AppointmentBill | null> {
        return await this.repo.findOne({
            where: { AppointmentId: appointmentId, IsDeleted: false },
            relations: ["BillItems", "Patient", "Provider", "Hospital"]
        });
    }

    async findById(billId: string): Promise<AppointmentBill | null> {
        return await this.repo.findOne({
            where: { AppointmentBillId: billId, IsDeleted: false },
            relations: ["BillItems", "Patient", "Provider", "Hospital"]
        });
    }

    async createBillWithItem(data: {
        appointmentId: number;
        patientId: string;
        providerId?: string;
        hospitalId: number;
        consultationFee: number;
        config?: HospitalPaymentConfiguration | null;
    }): Promise<AppointmentBill> {
        const { appointmentId, patientId, providerId, hospitalId, consultationFee, config } = data;

        // Calculate Inclusive GST and Breakdowns
        const gstPct = config?.GstPercentage || 0;
        const cgstPct = config?.CgstPercentage || 0;
        const sgstPct = config?.SgstPercentage || 0;
        const igstPct = config?.IgstPercentage || 0;

        const totalAmount = consultationFee;
        const subTotal = parseFloat((totalAmount / (1 + (gstPct / 100))).toFixed(2));
        const gstAmount = parseFloat((totalAmount - subTotal).toFixed(2));
        
        const cgstAmount = parseFloat(((subTotal * cgstPct) / 100).toFixed(2));
        const sgstAmount = parseFloat(((subTotal * sgstPct) / 100).toFixed(2));
        const igstAmount = parseFloat(((subTotal * igstPct) / 100).toFixed(2));

        // Generate bill number
        const prefix = config?.InvoicePrefix || "INV";
        const seq = config?.InvoiceSequence || 1;
        const billNumber = `${prefix}-${String(seq).padStart(6, "0")}-${Date.now().toString().slice(-4)}`;

        // Increment invoice sequence
        if (config) {
            await AppDataSource.getRepository(HospitalPaymentConfiguration).update(
                config.HospitalPaymentConfigurationId,
                { InvoiceSequence: seq + 1, UpdatedAt: new Date() }
            );
        }

        const bill = this.repo.create({
            AppointmentBillId: uuidv4(),
            AppointmentId: appointmentId,
            PatientId: patientId,
            ProviderId: providerId || null,
            HospitalId: hospitalId,
            BillNumber: billNumber,
            BillType: "Appointment",
            SubTotal: subTotal,
            GstAmount: gstAmount,
            CgstAmount: cgstAmount,
            SgstAmount: sgstAmount,
            IgstAmount: igstAmount,
            TotalAmount: totalAmount,
            PaidAmount: 0,
            DueAmount: totalAmount,
            BillStatus: "Pending",
            CreatedAt: new Date()
        });

        const savedBill = await this.repo.save(bill);

        // Create consultation bill item
        const item = this.itemRepo.create({
            AppointmentBillItemId: uuidv4(),
            AppointmentBillId: savedBill.AppointmentBillId,
            ItemType: "Consultation",
            ItemName: "Consultation Fee",
            Quantity: 1,
            UnitPrice: consultationFee,
            DiscountAmount: 0,
            GstPercentage: gstPct,
            GstAmount: gstAmount,
            TotalAmount: totalAmount,
            CreatedAt: new Date()
        });

        await this.itemRepo.save(item);

        return savedBill;
    }

    async updateBillOnPaymentSuccess(billId: string, paidAmount: number): Promise<void> {
        const bill = await this.repo.findOne({ where: { AppointmentBillId: billId } });
        if (!bill) return;

        const newPaid = parseFloat((Number(bill.PaidAmount) + paidAmount).toFixed(2));
        const newDue = parseFloat((Number(bill.TotalAmount) - newPaid).toFixed(2));
        const newStatus = newDue <= 0 ? "Paid" : "PartiallyPaid";

        await this.repo.update(billId, {
            PaidAmount: newPaid,
            DueAmount: Math.max(0, newDue),
            BillStatus: newStatus,
            UpdatedAt: new Date()
        });
    }

    async updateBillBaseAmount(billId: string, newConsultationFee: number, config?: HospitalPaymentConfiguration | null): Promise<AppointmentBill> {
        const bill = await this.repo.findOne({ where: { AppointmentBillId: billId }, relations: ["BillItems"] });
        if (!bill || bill.BillStatus !== "Pending") return bill as any; // Only update pending bills

        const gstPct = config?.GstPercentage || 0;
        const cgstPct = config?.CgstPercentage || 0;
        const sgstPct = config?.SgstPercentage || 0;
        const igstPct = config?.IgstPercentage || 0;

        const totalAmount = newConsultationFee;
        const subTotal = parseFloat((totalAmount / (1 + (gstPct / 100))).toFixed(2));
        const gstAmount = parseFloat((totalAmount - subTotal).toFixed(2));
        
        const cgstAmount = parseFloat(((subTotal * cgstPct) / 100).toFixed(2));
        const sgstAmount = parseFloat(((subTotal * sgstPct) / 100).toFixed(2));
        const igstAmount = parseFloat(((subTotal * igstPct) / 100).toFixed(2));

        // Update bill
        await this.repo.update(billId, {
            SubTotal: subTotal,
            GstAmount: gstAmount,
            CgstAmount: cgstAmount,
            SgstAmount: sgstAmount,
            IgstAmount: igstAmount,
            TotalAmount: totalAmount,
            DueAmount: totalAmount,
            UpdatedAt: new Date()
        });

        // Update the consultation item
        const item = bill.BillItems?.find(i => i.ItemType === "Consultation");
        if (item) {
            await this.itemRepo.update(item.AppointmentBillItemId, {
                UnitPrice: subTotal,
                GstPercentage: gstPct,
                GstAmount: gstAmount,
                TotalAmount: totalAmount
            });
        }

        // Return updated bill
        return (await this.repo.findOne({ where: { AppointmentBillId: billId }, relations: ["BillItems"] }))!;
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
    }): Promise<{ data: AppointmentBill[]; total: number; totalCollected: number; totalPending: number }> {
        const { orgId, hospitalId, providerId, patientId, billStatus, startDate, endDate, search, page = 1, limit = 20 } = filters;

        const qb = this.repo.createQueryBuilder("b")
            .leftJoinAndSelect("b.Patient", "patient")
            .leftJoinAndSelect("b.Provider", "provider")
            .leftJoinAndSelect("b.Hospital", "hospital")
            .leftJoinAndSelect("b.Appointment", "appointment")
            .leftJoinAndSelect("appointment.Organization", "org")
            .leftJoinAndSelect("b.BillItems", "items")
            .where("b.IsDeleted = :deleted", { deleted: false });

        if (hospitalId) qb.andWhere("b.HospitalId = :hospitalId", { hospitalId });
        if (orgId) qb.andWhere("appointment.OrgId = :orgId", { orgId });
        if (providerId) qb.andWhere("b.ProviderId = :providerId", { providerId });
        if (patientId) qb.andWhere("b.PatientId = :patientId", { patientId });
        if (billStatus) qb.andWhere("b.BillStatus = :billStatus", { billStatus });
        if (startDate) qb.andWhere("b.CreatedAt >= :startDate", { startDate: new Date(startDate) });
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            qb.andWhere("b.CreatedAt <= :endDate", { endDate: end });
        }
        if (search) {
            qb.andWhere(
                "(b.BillNumber LIKE :s OR patient.FirstName LIKE :s OR patient.LastName LIKE :s OR patient.PhoneNumber LIKE :s)",
                { s: `%${search}%` }
            );
        }

        qb.orderBy("b.CreatedAt", "DESC")
          .skip((page - 1) * limit)
          .take(limit);

        const [data, total] = await qb.getManyAndCount();

        // Aggregates
        const aggQb = this.repo.createQueryBuilder("b")
            .leftJoin("b.Appointment", "appointment")
            .select("SUM(b.PaidAmount)", "collected")
            .addSelect("SUM(b.DueAmount)", "pending")
            .where("b.IsDeleted = :deleted", { deleted: false });

        if (hospitalId) aggQb.andWhere("b.HospitalId = :hospitalId", { hospitalId });
        if (orgId) aggQb.andWhere("appointment.OrgId = :orgId", { orgId });
        if (providerId) aggQb.andWhere("b.ProviderId = :providerId", { providerId });
        if (patientId) aggQb.andWhere("b.PatientId = :patientId", { patientId });
        if (startDate) aggQb.andWhere("b.CreatedAt >= :startDate", { startDate: new Date(startDate) });
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            aggQb.andWhere("b.CreatedAt <= :endDate", { endDate: end });
        }

        const agg = await aggQb.getRawOne();
        const totalCollected = parseFloat(agg?.collected || "0");
        const totalPending = parseFloat(agg?.pending || "0");

        return { data, total, totalCollected, totalPending };
    }
}

export const appointmentBillRepository = new AppointmentBillRepository();
