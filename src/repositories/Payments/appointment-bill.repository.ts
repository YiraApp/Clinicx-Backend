import { AppDataSource } from "../../config/database.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { AppointmentBillItem } from "../../models/Payments/appointment-bill-item.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";
import { Payment } from "../../models/Payments/payment.model.js";
import { v4 as uuidv4 } from "uuid";
import { EntityManager, In } from "typeorm/index.js";

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const roundMoney = (value: number) => Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;

export const computeBillStatus = (totalAmount: number, paidAmount: number, currentStatus?: string | null) => {
    if (currentStatus === "Cancelled") return currentStatus;
    const due = roundMoney(Number(totalAmount) - Number(paidAmount));
    if (Number(paidAmount) > 0 && due <= 0) return "Paid";
    if (Number(paidAmount) > 0) return "PartiallyPaid";
    return currentStatus === "Draft" ? "Draft" : "Pending";
};

export class AppointmentBillRepository {
    private repo = AppDataSource.getRepository(AppointmentBill);
    private itemRepo = AppDataSource.getRepository(AppointmentBillItem);

    async findByAppointmentId(appointmentId: number): Promise<AppointmentBill | null> {
        return await this.repo.findOne({
            where: { AppointmentId: appointmentId, IsDeleted: false },
            relations: ["BillItems", "Patient", "Provider", "Hospital"]
        });
    }

    async getRootAppointmentId(appointmentId: number): Promise<number> {
        const { Appointment } = await import("../../models/Appointments/appointment.model.js");
        const appRepo = AppDataSource.getRepository(Appointment);
        let rootId = appointmentId;
        const visited = new Set<number>();
        while (rootId && !visited.has(rootId)) {
            visited.add(rootId);
            const appt = await appRepo.findOne({ where: { Id: rootId } });
            if (!appt?.ParentAppointmentId) break;
            rootId = appt.ParentAppointmentId;
        }
        return rootId;
    }

    async getChainAppointmentIds(rootAppointmentId: number): Promise<number[]> {
        const { Appointment } = await import("../../models/Appointments/appointment.model.js");
        const appRepo = AppDataSource.getRepository(Appointment);
        const ids = new Set<number>([rootAppointmentId]);
        let frontier = [rootAppointmentId];
        while (frontier.length > 0) {
            const children = await appRepo.find({ where: { ParentAppointmentId: In(frontier) } });
            frontier = children.map(c => c.Id).filter(id => !ids.has(id));
            frontier.forEach(id => ids.add(id));
        }
        return Array.from(ids);
    }

    /**
     * Follow-up visits append their charges to the root visit's bill, so a follow-up appointment
     * usually has no bill of its own. Look up the chain before concluding that no bill exists.
     */
    async findBillForAppointment(appointmentId: number): Promise<AppointmentBill | null> {
        const own = await this.findByAppointmentId(appointmentId);
        if (own) return own;
        const rootId = await this.getRootAppointmentId(appointmentId);
        return rootId !== appointmentId ? await this.findByAppointmentId(rootId) : null;
    }

    /**
     * Older payment flows created a separate bill for a follow-up visit whose charges were already on
     * the root bill. The billing list shows such bills as one consolidated row, so fold them into the
     * root bill (keeping the combined totals, items and payments) before a payment or an edit.
     */
    async mergeBillGroup(billId: string): Promise<AppointmentBill> {
        const bill = await this.findById(billId);
        if (!bill) throw new Error("Bill not found.");
        if (!bill.AppointmentId) return bill;

        const rootId = await this.getRootAppointmentId(bill.AppointmentId);
        const chainIds = await this.getChainAppointmentIds(rootId);
        const members = await this.repo.find({
            where: { AppointmentId: In(chainIds), IsDeleted: false },
            order: { CreatedAt: "ASC" }
        });
        if (members.length <= 1) return bill;

        const primary = members.find(m => m.AppointmentId === rootId) || members[0];
        const others = members.filter(m => m.AppointmentBillId !== primary.AppointmentBillId);
        const sum = (field: keyof AppointmentBill) => roundMoney(members.reduce((s, m) => s + Number(m[field] || 0), 0));

        await AppDataSource.transaction(async (manager) => {
            for (const other of others) {
                await manager.createQueryBuilder().update(AppointmentBillItem)
                    .set({ AppointmentBillId: primary.AppointmentBillId, AppointmentId: () => `COALESCE(AppointmentId, ${Number(other.AppointmentId)})` })
                    .where("AppointmentBillId = :id", { id: other.AppointmentBillId })
                    .execute();
                await manager.createQueryBuilder().update(Payment)
                    .set({ AppointmentBillId: primary.AppointmentBillId })
                    .where("AppointmentBillId = :id", { id: other.AppointmentBillId })
                    .execute();
                await manager.update(AppointmentBill, other.AppointmentBillId, {
                    IsDeleted: true,
                    Notes: `${other.Notes ? other.Notes + " | " : ""}Merged into bill ${primary.BillNumber}`,
                    UpdatedAt: new Date()
                });
            }

            const totalAmount = sum("TotalAmount");
            const paidAmount = sum("PaidAmount");
            await manager.update(AppointmentBill, primary.AppointmentBillId, {
                SubTotal: sum("SubTotal"),
                DiscountAmount: sum("DiscountAmount"),
                GstAmount: sum("GstAmount"),
                CgstAmount: sum("CgstAmount"),
                SgstAmount: sum("SgstAmount"),
                IgstAmount: sum("IgstAmount"),
                TotalAmount: totalAmount,
                PaidAmount: paidAmount,
                DueAmount: Math.max(0, roundMoney(totalAmount - paidAmount)),
                BillStatus: computeBillStatus(totalAmount, paidAmount, primary.BillStatus),
                UpdatedAt: new Date()
            });
        });

        console.log(`[AppointmentBill] Merged ${others.length} follow-up bill(s) into bill ${primary.AppointmentBillId}`);
        return (await this.findById(primary.AppointmentBillId))!;
    }

    /**
     * Adds a payment to a bill in a single UPDATE so concurrent collections cannot lose or double an
     * amount. With `rejectOverDue`, nothing is written (returns false) when the amount exceeds the due.
     */
    async applyPayment(billId: string, amount: number, options: { rejectOverDue: boolean }, manager?: EntityManager): Promise<boolean> {
        const paid = roundMoney(amount);
        const qb = (manager || AppDataSource.manager).createQueryBuilder()
            .update(AppointmentBill)
            .set({
                PaidAmount: () => "PaidAmount + :paid",
                DueAmount: () => "CASE WHEN TotalAmount - (PaidAmount + :paid) > 0 THEN TotalAmount - (PaidAmount + :paid) ELSE 0 END",
                BillStatus: () => "CASE WHEN TotalAmount - (PaidAmount + :paid) <= 0 THEN 'Paid' ELSE 'PartiallyPaid' END",
                // The app's clock, like every other write (GETDATE() on the Azure server is UTC)
                UpdatedAt: new Date()
            })
            .where("AppointmentBillId = :billId AND IsDeleted = 0", { billId })
            .setParameter("paid", paid);
        if (options.rejectOverDue) {
            qb.andWhere("BillStatus <> 'Cancelled' AND TotalAmount - PaidAmount >= :minDue", { minDue: paid - 0.005 });
        }
        const result = await qb.execute();
        return (result.affected || 0) > 0;
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

        const subTotal = consultationFee;
        const gstAmount = parseFloat(((subTotal * gstPct) / 100).toFixed(2));
        const totalAmount = parseFloat((subTotal + gstAmount).toFixed(2));
        
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

    async createBillForAppointment(
        appointmentId: number,
        data: {
            patientId: string;
            providerId?: string;
            hospitalId: number;
            consultationFee: number;
            treatmentPlanIds?: string[];
            customTreatmentPlans?: { name: string; amount: number; description?: string }[];
            discountAmount?: number;
        }
    ): Promise<AppointmentBill> {
        // Calculate Inclusive GST and Breakdowns using Hospital Config
        const { Appointment } = await import("../../models/Appointments/appointment.model.js");
        const appt = await AppDataSource.getRepository(Appointment).findOne({ where: { Id: appointmentId } });
        const resolvedProviderId = data.providerId || appt?.DoctorId || null;

        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const config = await configRepo.findOne({
            where: { HospitalId: data.hospitalId, IsDeleted: false }
        });

        const gstPct = config?.GstPercentage || 0;
        const cgstPct = config?.CgstPercentage || 0;
        const sgstPct = config?.SgstPercentage || 0;
        const igstPct = config?.IgstPercentage || 0;

        let subTotalSum = 0;
        const itemsToCreate: any[] = [];

        // 1. Consultation Item
        if (data.consultationFee > 0) {
            const unitPrice = data.consultationFee;
            const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
            const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
            subTotalSum += unitPrice;

            itemsToCreate.push({
                ItemType: "Consultation",
                ItemName: "Consultation Fee",
                Quantity: 1,
                UnitPrice: unitPrice,
                DiscountAmount: 0,
                GstPercentage: gstPct,
                GstAmount: gst,
                TotalAmount: totalItemAmt
            });
        }

        // 2. Predefined Treatment Plans
        if (data.treatmentPlanIds && data.treatmentPlanIds.length > 0) {
            const planRepo = AppDataSource.getRepository(TreatmentPlan);
            const plans = await planRepo.findByIds(data.treatmentPlanIds);
            for (const plan of plans) {
                const unitPrice = plan.Amount;
                const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
                const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
                subTotalSum += unitPrice;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemReferenceId: plan.TreatmentPlanId,
                    ItemName: plan.Name,
                    Quantity: 1,
                    UnitPrice: unitPrice,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        // 3. Custom Treatment Plans
        if (data.customTreatmentPlans && data.customTreatmentPlans.length > 0) {
            for (const cp of data.customTreatmentPlans) {
                const unitPrice = cp.amount;
                const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
                const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
                subTotalSum += unitPrice;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemName: cp.name,
                    Quantity: 1,
                    UnitPrice: unitPrice,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        // 4. NO bill number yet — bill starts as Draft
        const overallDiscount = Math.min(Math.max(0, Number(data.discountAmount) || 0), subTotalSum);
        const finalTaxable = Math.max(0, subTotalSum - overallDiscount);

        const finalGst = parseFloat(((finalTaxable * gstPct) / 100).toFixed(2));
        const cgstAmount = parseFloat(((finalTaxable * cgstPct) / 100).toFixed(2));
        const sgstAmount = parseFloat(((finalTaxable * sgstPct) / 100).toFixed(2));
        const igstAmount = parseFloat(((finalTaxable * igstPct) / 100).toFixed(2));

        const totalAmount = parseFloat((finalTaxable + finalGst).toFixed(2));

        // Create main bill as DRAFT — no invoice number assigned yet
        const bill = this.repo.create({
            AppointmentBillId: uuidv4(),
            AppointmentId: appointmentId,
            PatientId: data.patientId,
            ProviderId: resolvedProviderId,
            HospitalId: data.hospitalId,
            BillNumber: `DFT-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`,          // Place holder, formal INV number assigned when invoice is generated
            BillType: "Appointment",
            SubTotal: subTotalSum,
            DiscountAmount: overallDiscount,
            GstAmount: finalGst,
            CgstAmount: cgstAmount,
            SgstAmount: sgstAmount,
            IgstAmount: igstAmount,
            TotalAmount: totalAmount,
            PaidAmount: 0,
            DueAmount: totalAmount,
            BillStatus: "Draft",              // Draft until staff clicks Generate Invoice
            CreatedAt: new Date()
        });

        const savedBill = await this.repo.save(bill);

        // Create items
        for (const it of itemsToCreate) {
            const item = this.itemRepo.create({
                AppointmentBillItemId: uuidv4(),
                AppointmentBillId: savedBill.AppointmentBillId,
                AppointmentId: appointmentId,
                ...it,
                CreatedAt: new Date()
            });
            await this.itemRepo.save(item);
        }

        return savedBill;
    }

    async appendChildItemsToBill(
        billId: string,
        appointmentId: number,
        data: {
            consultationFee: number;
            treatmentPlanIds?: string[];
            customTreatmentPlans?: { name: string; amount: number; description?: string }[];
            discountAmount?: number;
        }
    ): Promise<AppointmentBill> {
        const bill = await this.repo.findOne({
            where: { AppointmentBillId: billId },
            relations: ["BillItems", "Hospital"]
        });
        if (!bill) throw new Error("Bill not found");

        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const config = await configRepo.findOne({
            where: { HospitalId: bill.HospitalId, IsDeleted: false }
        });

        const gstPct = config?.GstPercentage || 0;
        const cgstPct = config?.CgstPercentage || 0;
        const sgstPct = config?.SgstPercentage || 0;
        const igstPct = config?.IgstPercentage || 0;

        let subTotalSum = Number(bill.SubTotal) || 0;
        const itemsToCreate: any[] = [];

        // 1. Consultation Item
        if (data.consultationFee > 0) {
            const unitPrice = data.consultationFee;
            const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
            const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
            subTotalSum += unitPrice;

            itemsToCreate.push({
                ItemType: "Consultation",
                ItemName: "Consultation Fee (Follow-up)",
                Quantity: 1,
                UnitPrice: unitPrice,
                DiscountAmount: 0,
                GstPercentage: gstPct,
                GstAmount: gst,
                TotalAmount: totalItemAmt
            });
        }

        // 2. Predefined Treatment Plans
        if (data.treatmentPlanIds && data.treatmentPlanIds.length > 0) {
            const plans = await AppDataSource.getRepository(TreatmentPlan).findByIds(data.treatmentPlanIds);
            for (const plan of plans) {
                const unitPrice = plan.Amount;
                const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
                const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
                subTotalSum += unitPrice;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemReferenceId: plan.TreatmentPlanId,
                    ItemName: plan.Name,
                    Quantity: 1,
                    UnitPrice: unitPrice,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        // 3. Custom Treatment Plans
        if (data.customTreatmentPlans && data.customTreatmentPlans.length > 0) {
            for (const cp of data.customTreatmentPlans) {
                const unitPrice = cp.amount;
                const gst = parseFloat(((unitPrice * gstPct) / 100).toFixed(2));
                const totalItemAmt = parseFloat((unitPrice + gst).toFixed(2));
                subTotalSum += unitPrice;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemName: cp.name,
                    Quantity: 1,
                    UnitPrice: unitPrice,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        const newDiscount = Math.min((Number(bill.DiscountAmount) || 0) + Math.max(0, Number(data.discountAmount) || 0), subTotalSum);
        const finalTaxable = Math.max(0, subTotalSum - newDiscount);
        
        const finalGst = parseFloat(((finalTaxable * gstPct) / 100).toFixed(2));
        const cgstAmount = parseFloat(((finalTaxable * cgstPct) / 100).toFixed(2));
        const sgstAmount = parseFloat(((finalTaxable * sgstPct) / 100).toFixed(2));
        const igstAmount = parseFloat(((finalTaxable * igstPct) / 100).toFixed(2));

        const totalAmount = parseFloat((finalTaxable + finalGst).toFixed(2));
        const dueAmount = parseFloat((totalAmount - Number(bill.PaidAmount)).toFixed(2));

        // Save items first
        for (const it of itemsToCreate) {
            const item = this.itemRepo.create({
                AppointmentBillItemId: uuidv4(),
                AppointmentBillId: bill.AppointmentBillId,
                AppointmentId: appointmentId,
                ...it,
                CreatedAt: new Date()
            });
            await this.itemRepo.save(item);
        }

        // Update bill values
        await this.repo.update(bill.AppointmentBillId, {
            SubTotal: subTotalSum,
            DiscountAmount: newDiscount,
            GstAmount: finalGst,
            CgstAmount: cgstAmount,
            SgstAmount: sgstAmount,
            IgstAmount: igstAmount,
            TotalAmount: totalAmount,
            DueAmount: Math.max(0, dueAmount),
            BillStatus: computeBillStatus(totalAmount, Number(bill.PaidAmount), bill.BillStatus),
            UpdatedAt: new Date()
        });

        return bill;
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
            .leftJoinAndSelect("appointment.Doctor", "doctor")
            .leftJoinAndSelect("appointment.Organization", "org")
            .leftJoinAndSelect("b.BillItems", "items")
            .where("b.IsDeleted = :deleted", { deleted: false });

        // A manual bill has no appointment, so its organisation is its hospital's
        const orgCondition = "(appointment.OrgId = :orgId OR (b.AppointmentId IS NULL AND hospital.OrganizationId = :orgId))";
        if (hospitalId) qb.andWhere("b.HospitalId = :hospitalId", { hospitalId });
        if (orgId) qb.andWhere(orgCondition, { orgId });
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

        qb.addSelect("COALESCE(b.UpdatedAt, b.CreatedAt)", "latest_activity")
          .orderBy("latest_activity", "DESC")
          .skip((page - 1) * limit)
          .take(limit);

        const [data, total] = await qb.getManyAndCount();

        // Aggregates
        const aggQb = this.repo.createQueryBuilder("b")
            .leftJoin("b.Appointment", "appointment")
            .leftJoin("b.Patient", "patient")
            .leftJoin("b.Hospital", "hospital")
            .select("SUM(b.PaidAmount)", "collected")
            .addSelect("SUM(b.DueAmount)", "pending")
            .where("b.IsDeleted = :deleted", { deleted: false });

        if (hospitalId) aggQb.andWhere("b.HospitalId = :hospitalId", { hospitalId });
        if (orgId) aggQb.andWhere(orgCondition, { orgId });
        if (providerId) aggQb.andWhere("b.ProviderId = :providerId", { providerId });
        if (patientId) aggQb.andWhere("b.PatientId = :patientId", { patientId });
        if (billStatus) aggQb.andWhere("b.BillStatus = :billStatus", { billStatus });
        if (search) {
            aggQb.andWhere(
                "(b.BillNumber LIKE :s OR patient.FirstName LIKE :s OR patient.LastName LIKE :s OR patient.PhoneNumber LIKE :s)",
                { s: `%${search}%` }
            );
        }
        if (startDate) aggQb.andWhere("b.CreatedAt >= :startDate", { startDate: new Date(startDate) });
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            aggQb.andWhere("b.CreatedAt <= :endDate", { endDate: end });
        }

        const agg = await aggQb.getRawOne();
        const totalCollected = parseFloat(agg?.collected || "0");
        const totalPending = parseFloat(agg?.pending || "0");

        const { Appointment } = await import("../../models/Appointments/appointment.model.js");
        const appRepo = AppDataSource.getRepository(Appointment);

        // Batch load appointment chain in memory to eliminate N+1 queries
        const apptCache = new Map<number, any>();
        let currentIdsToFetch = data.map(b => b.AppointmentId).filter(Boolean) as number[];

        while (currentIdsToFetch.length > 0) {
            const idsToQuery = Array.from(new Set(currentIdsToFetch.filter(id => !apptCache.has(id))));
            if (idsToQuery.length === 0) {
                break;
            }

            const appts = await appRepo.find({ where: { Id: In(idsToQuery) } });
            for (const id of idsToQuery) {
                apptCache.set(id, null); // default to null
            }
            for (const app of appts) {
                apptCache.set(app.Id, app);
            }

            const parentIds: number[] = [];
            for (const app of appts) {
                if (app.ParentAppointmentId) {
                    parentIds.push(app.ParentAppointmentId);
                }
            }
            currentIdsToFetch = parentIds;
        }

        const nonApptBills: AppointmentBill[] = [];
        const rootIdByBill = new Map<string, number>();

        for (const bill of data) {
            if (!bill.AppointmentId) {
                nonApptBills.push(bill);
                continue;
            }

            // Trace to the root parent appointment using cached in-memory entries
            let rootParentId = bill.AppointmentId;
            let currentId = bill.AppointmentId;
            const visitedAppts = new Set<number>();
            while (currentId) {
                if (visitedAppts.has(currentId)) {
                    break;
                }
                visitedAppts.add(currentId);
                const appt = apptCache.get(currentId);
                if (appt && appt.ParentAppointmentId) {
                    currentId = appt.ParentAppointmentId;
                    rootParentId = appt.ParentAppointmentId;
                } else {
                    break;
                }
            }
            rootIdByBill.set(bill.AppointmentBillId, rootParentId);
        }

        // Older payment flows created separate bills for follow-up visits. Load every bill in each
        // chain (not only the ones on this page) and show the root visit's bill as the row, so the
        // consolidated totals do not change with sort order or paging.
        const rootOfAppt = new Map<number, number>();
        let frontier = Array.from(new Set(rootIdByBill.values()));
        frontier.forEach(id => rootOfAppt.set(id, id));
        while (frontier.length > 0) {
            const children = await appRepo.find({ where: { ParentAppointmentId: In(frontier) } });
            frontier = [];
            for (const child of children) {
                if (rootOfAppt.has(child.Id)) continue;
                rootOfAppt.set(child.Id, rootOfAppt.get(child.ParentAppointmentId!)!);
                frontier.push(child.Id);
            }
        }
        const chainBills = rootOfAppt.size > 0
            ? await this.repo.find({
                where: { AppointmentId: In(Array.from(rootOfAppt.keys())), IsDeleted: false },
                relations: ["Patient", "Provider", "Hospital", "Appointment", "Appointment.Doctor", "Appointment.Organization", "BillItems"],
                order: { CreatedAt: "ASC" }
            })
            : [];

        const consolidatedBills: any[] = [];
        const seenRoots = new Set<number>();
        for (const bill of data) {
            if (!bill.AppointmentId) continue;
            const rootParentId = rootIdByBill.get(bill.AppointmentBillId)!;
            if (seenRoots.has(rootParentId)) continue;
            seenRoots.add(rootParentId);

            const members = chainBills.filter(b => rootOfAppt.get(b.AppointmentId!) === rootParentId);
            if (members.length <= 1) {
                consolidatedBills.push({ ...bill, rootAppointmentId: rootParentId });
                continue;
            }

            const primary = members.find(m => m.AppointmentId === rootParentId) || members[0];
            const sum = (field: keyof AppointmentBill) => roundMoney(members.reduce((s, m) => s + Number(m[field] || 0), 0));
            const totalAmount = sum("TotalAmount");
            const paidAmount = sum("PaidAmount");
            consolidatedBills.push({
                ...primary,
                rootAppointmentId: rootParentId,
                BillItems: members.flatMap(m => (m.BillItems || []).map(item => ({
                    ...item,
                    AppointmentId: item.AppointmentId ?? (m === primary ? null : m.AppointmentId)
                }))),
                SubTotal: sum("SubTotal"),
                DiscountAmount: sum("DiscountAmount"),
                GstAmount: sum("GstAmount"),
                CgstAmount: sum("CgstAmount"),
                SgstAmount: sum("SgstAmount"),
                IgstAmount: sum("IgstAmount"),
                TotalAmount: totalAmount,
                PaidAmount: paidAmount,
                DueAmount: Math.max(0, roundMoney(totalAmount - paidAmount)),
                BillStatus: computeBillStatus(totalAmount, paidAmount, primary.BillStatus),
                UpdatedAt: members.reduce((latest: Date | null | undefined, m) => (m.UpdatedAt && (!latest || m.UpdatedAt > latest) ? m.UpdatedAt : latest), primary.UpdatedAt)
            });
        }
        consolidatedBills.push(...nonApptBills);

        // Attach appointment chain (parent + child visits) to each consolidated bill
        const payRepo = AppDataSource.getRepository(Payment);
        const billsWithChain = await Promise.all(consolidatedBills.map(async (bill) => {
            if (!bill.AppointmentId) return { ...bill, appointmentChain: [] };

            // Collect the full appointment chain starting from root
            const chain: any[] = [];
            const rootAppointmentId = bill.rootAppointmentId || bill.AppointmentId;
            const rootAppt = await appRepo.findOne({
                where: { Id: rootAppointmentId },
                relations: ["Doctor"]
            });
            if (rootAppt) {
                chain.push({
                    id: rootAppt.Id,
                    date: rootAppt.AppointmentDate,
                    type: rootAppt.AppointmentType,
                    reason: rootAppt.Reason,
                    status: rootAppt.Status,
                    providerName: rootAppt.Doctor
                        ? `Dr. ${(rootAppt.Doctor as any).FirstName || ""} ${(rootAppt.Doctor as any).LastName || ""}`.trim()
                        : null
                });
            }

            // Find all descendants recursively
            const findChildren = async (parentId: number) => {
                const children = await appRepo.find({
                    where: { ParentAppointmentId: parentId },
                    relations: ["Doctor"]
                });
                for (const child of children) {
                    chain.push({
                        id: child.Id,
                        date: child.AppointmentDate,
                        type: child.AppointmentType,
                        reason: child.Reason,
                        status: child.Status,
                        providerName: child.Doctor
                            ? `Dr. ${(child.Doctor as any).FirstName || ""} ${(child.Doctor as any).LastName || ""}`.trim()
                            : null
                    });
                    await findChildren(child.Id);
                }
            };
            await findChildren(rootAppointmentId);

            // Fetch items and payments for each visit in the chain
            const enrichedChain = await Promise.all(chain.map(async (appt) => {
                // Only money actually received; abandoned or failed gateway orders stay out of the totals
                const apptPayments = await payRepo.find({
                    where: { AppointmentId: appt.id, Status: "Success" }
                });
                
                const apptItems = bill.BillItems ? bill.BillItems.filter((bi: AppointmentBillItem) => {
                    if (bi.AppointmentId === appt.id) return true;
                    if (!bi.AppointmentId && appt.id === rootAppointmentId) return true;
                    return false;
                }) : [];

                return {
                    ...appt,
                    items: apptItems.map((item: AppointmentBillItem) => ({
                        itemName: item.ItemName,
                        itemType: item.ItemType,
                        unitPrice: Number(item.UnitPrice),
                        quantity: Number(item.Quantity),
                        discountAmount: Number(item.DiscountAmount),
                        gstPercentage: Number(item.GstPercentage || 0),
                        gstAmount: Number(item.GstAmount || 0),
                        totalAmount: Number(item.TotalAmount)
                    })),
                    payments: apptPayments.map(p => ({
                        paymentId: p.PaymentId,
                        amount: Number(p.Amount),
                        method: p.PaymentMethod,
                        transactionId: p.TransactionId,
                        createdAt: p.CreatedAt
                    }))
                };
            }));

            return { ...bill, appointmentChain: enrichedChain };
        }));

        return { data: billsWithChain as any[], total, totalCollected, totalPending };
    }

    /**
     * Generate Invoice: assigns a bill number and moves the bill from Draft → Pending.
     * This is called when staff clicks "Generate Invoice" on the billing page.
     */
    async generateInvoice(billId: string): Promise<AppointmentBill> {
        const bill = await this.repo.findOne({
            where: { AppointmentBillId: billId, IsDeleted: false }
        });
        if (!bill) throw new Error("Bill not found.");
        const isDraft = bill.BillStatus === "Draft" || !bill.BillNumber || bill.BillNumber.startsWith("DFT-");
        if (!isDraft) throw new Error("Invoice already generated for this bill.");

        const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
        const config = await configRepo.findOne({
            where: { HospitalId: bill.HospitalId, IsDeleted: false }
        });

        const prefix = config?.InvoicePrefix || "INV";
        const seq = config?.InvoiceSequence || 1;
        const billNumber = `${prefix}-${String(seq).padStart(6, "0")}-${Date.now().toString().slice(-4)}`;

        if (config) {
            await configRepo.update(config.HospitalPaymentConfigurationId, {
                InvoiceSequence: seq + 1,
                UpdatedAt: new Date()
            });
        }

        const newStatus = Number(bill.DueAmount) <= 0
            ? (Number(bill.PaidAmount) > 0 ? "Paid" : "Pending")
            : (Number(bill.PaidAmount) > 0 ? "PartiallyPaid" : "Pending");

        await this.repo.update(billId, {
            BillNumber: billNumber,
            BillStatus: newStatus,
            UpdatedAt: new Date()
        });

        return (await this.findById(billId))!;
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
                itemReferenceId?: string | null; // the treatment plan the item was picked from
            }[];
            discountAmount: number; // General bill discount
            notes?: string;
            gstPercentage?: number;
            gstAmount?: number;
        }
    ): Promise<AppointmentBill> {
        // A bill always keeps at least one item; the old items are replaced by these
        if (!Array.isArray(data.items) || data.items.length === 0) {
            throw new Error("A bill must have at least one item.");
        }

        // The edit dialog sends the items of the whole consolidated row, so fold legacy follow-up bills in first
        billId = (await this.mergeBillGroup(billId)).AppointmentBillId;

        return await AppDataSource.transaction(async (manager) => {
            const billRepo = manager.getRepository(AppointmentBill);
            const itemRepo = manager.getRepository(AppointmentBillItem);

            const bill = await billRepo.findOne({
                where: { AppointmentBillId: billId, IsDeleted: false },
                relations: ["BillItems", "Hospital"]
            });
            if (!bill) throw new Error("Bill not found.");
            if (bill.BillStatus === "Paid" || bill.BillStatus === "Cancelled") {
                throw new Error(`Cannot edit a ${bill.BillStatus === "Paid" ? "fully paid" : "cancelled"} bill.`);
            }

            // 1. Fetch Hospital Payment Configuration for GST calculations
            const configRepo = manager.getRepository(HospitalPaymentConfiguration);
            const config = await configRepo.findOne({
                where: { HospitalId: bill.HospitalId, IsDeleted: false }
            });

            const configGst = config?.GstPercentage || 0;
            const configCgst = config?.CgstPercentage || 0;
            const configSgst = config?.SgstPercentage || 0;
            const configIgst = config?.IgstPercentage || 0;

            const gstPct = data.gstPercentage !== undefined && data.gstPercentage !== null ? Number(data.gstPercentage) : configGst;

            let cgstPct = 0;
            let sgstPct = 0;
            let igstPct = 0;

            if (configGst > 0) {
                cgstPct = (gstPct * configCgst) / configGst;
                sgstPct = (gstPct * configSgst) / configGst;
                igstPct = (gstPct * configIgst) / configGst;
            } else {
                cgstPct = gstPct / 3;
                sgstPct = gstPct / 3;
                igstPct = gstPct / 3;
            }

            // 2. Clear old items
            await itemRepo.delete({ AppointmentBillId: billId });

            // 3. Insert new items and compute subtotal
            let subTotalSum = 0;
            let itemsDiscountSum = 0;
            let gstSum = 0;

            const savedItems: AppointmentBillItem[] = [];

            for (const it of data.items) {
                const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
                const price = Math.max(0, Number(it.unitPrice) || 0);
                const disc = Math.min(Math.max(0, Number(it.discountAmount) || 0), price * qty);
                const itemGstPct = it.gstPercentage !== undefined ? Number(it.gstPercentage) : gstPct;

                // Base amount before discount and tax
                const baseAmount = price * qty;
                // Net taxable value
                const taxableAmount = Math.max(0, baseAmount - disc);
                
                // GST calculations (exclusive)
                const gstAmt = parseFloat(((taxableAmount * itemGstPct) / 100).toFixed(2));
                const totalItemAmt = parseFloat((taxableAmount + gstAmt).toFixed(2));

                subTotalSum += baseAmount;
                itemsDiscountSum += disc;
                gstSum += gstAmt;

                const item = itemRepo.create({
                    AppointmentBillItemId: uuidv4(),
                    AppointmentBillId: billId,
                    AppointmentId: it.appointmentId ? Number(it.appointmentId) : null,
                    ItemType: it.itemType || "Custom",
                    // A uniqueidentifier column: anything that is not a GUID is dropped rather than failing the save
                    ItemReferenceId: it.itemReferenceId && GUID_PATTERN.test(String(it.itemReferenceId)) ? String(it.itemReferenceId) : null,
                    ItemName: it.itemName,
                    Quantity: qty,
                    UnitPrice: price,
                    DiscountAmount: disc,
                    GstPercentage: itemGstPct,
                    GstAmount: gstAmt,
                    TotalAmount: totalItemAmt,
                    CreatedAt: new Date()
                });

                const savedItem = await manager.save(AppointmentBillItem, item);
                savedItems.push(savedItem);
            }

            // 4. Calculate overall totals and clamp overall discount to not exceed remaining subtotal
            const maxOverallDiscount = Math.max(0, subTotalSum - itemsDiscountSum);
            const overallDiscount = Math.min(Number(data.discountAmount) || 0, maxOverallDiscount);
            const totalDiscount = itemsDiscountSum + overallDiscount;

            // If overall discount is applied, adjust subtotal/total
            const finalTaxable = Math.max(0, (subTotalSum - itemsDiscountSum) - overallDiscount);
            
            // Recalculate tax based on final taxable amount (using the hospital configuration distribution)
            const customGstAmount = data.gstAmount !== undefined && data.gstAmount !== null ? roundMoney(Math.max(0, Number(data.gstAmount) || 0)) : null;
            const finalGst = customGstAmount !== null ? customGstAmount : parseFloat(((finalTaxable * gstPct) / 100).toFixed(2));

            let cgstAmount = 0;
            let sgstAmount = 0;
            let igstAmount = 0;

            if (customGstAmount !== null) {
                if (gstPct > 0) {
                    cgstAmount = parseFloat(((customGstAmount * cgstPct) / gstPct).toFixed(2));
                    sgstAmount = parseFloat(((customGstAmount * sgstPct) / gstPct).toFixed(2));
                    igstAmount = parseFloat(((customGstAmount * igstPct) / gstPct).toFixed(2));
                } else {
                    cgstAmount = parseFloat((customGstAmount / 2).toFixed(2));
                    sgstAmount = parseFloat((customGstAmount - cgstAmount).toFixed(2));
                    igstAmount = 0;
                }
            } else {
                cgstAmount = parseFloat(((finalTaxable * cgstPct) / 100).toFixed(2));
                sgstAmount = parseFloat(((finalTaxable * sgstPct) / 100).toFixed(2));
                igstAmount = parseFloat(((finalTaxable * igstPct) / 100).toFixed(2));
            }

            const totalAmount = parseFloat((finalTaxable + finalGst).toFixed(2));

            if (totalAmount < roundMoney(Number(bill.PaidAmount))) {
                throw new Error(`The new total amount (₹${totalAmount}) cannot be less than the already collected/paid amount (₹${bill.PaidAmount})`);
            }

            // Update the main bill record
            await billRepo.update(billId, {
                SubTotal: subTotalSum,
                DiscountAmount: totalDiscount,
                GstAmount: finalGst,
                CgstAmount: cgstAmount,
                SgstAmount: sgstAmount,
                IgstAmount: igstAmount,
                TotalAmount: totalAmount,
                DueAmount: Math.max(0, roundMoney(totalAmount - Number(bill.PaidAmount))),
                BillStatus: computeBillStatus(totalAmount, Number(bill.PaidAmount), bill.BillStatus),
                Notes: data.notes !== undefined ? data.notes : bill.Notes,
                UpdatedAt: new Date()
            });

            const updatedBill = await billRepo.findOne({
                where: { AppointmentBillId: billId },
                relations: ["BillItems", "Patient", "Provider", "Hospital"]
            });
            return updatedBill!;
        });
    }

    /**
     * Takes a cancelled appointment's charges off its bill, so Billing stops showing them as due.
     * - Money already taken on the bill: nothing changes; staff settle it (edit or refund).
     * - A bill with only this visit on it: the bill is cancelled.
     * - A bill shared with follow-up visits: this visit's items come off and the totals are worked
     *   out again at the bill's own GST rate.
     */
    async cancelAppointmentCharges(appointmentId: number): Promise<"cancelled" | "items-removed" | "kept-paid" | "none"> {
        const bill = await this.findBillForAppointment(appointmentId);
        if (!bill || bill.BillStatus === "Cancelled") return "none";
        if (roundMoney(Number(bill.PaidAmount)) > 0) return "kept-paid";

        const items = bill.BillItems || [];
        const isOwnBill = Number(bill.AppointmentId) === Number(appointmentId);
        // An item is this visit's when it names the visit, or names no visit on the visit's own bill
        const isThisVisit = (it: AppointmentBillItem) =>
            it.AppointmentId != null ? Number(it.AppointmentId) === Number(appointmentId) : isOwnBill;
        const remaining = items.filter(it => !isThisVisit(it));

        if (items.length > 0 && remaining.length === items.length) return "none";

        if (remaining.length === 0) {
            await this.repo.update(bill.AppointmentBillId, {
                BillStatus: "Cancelled",
                DueAmount: 0,
                Notes: `${bill.Notes ? bill.Notes + " | " : ""}Appointment cancelled`,
                UpdatedAt: new Date()
            });
            return "cancelled";
        }

        const taxable = roundMoney(Number(bill.SubTotal) - Number(bill.DiscountAmount));
        const billGstPct = taxable > 0 ? roundMoney((Number(bill.GstAmount) / taxable) * 100) : 0;
        const itemDiscounts = roundMoney(items.reduce((s, it) => s + Number(it.DiscountAmount || 0), 0));
        await this.updateBillDetails(bill.AppointmentBillId, {
            items: remaining.map(it => ({
                itemName: it.ItemName,
                itemType: it.ItemType,
                unitPrice: Number(it.UnitPrice),
                quantity: Number(it.Quantity),
                discountAmount: Number(it.DiscountAmount || 0),
                gstPercentage: Number(it.GstPercentage || 0),
                appointmentId: it.AppointmentId ?? null,
                itemReferenceId: it.ItemReferenceId ?? null
            })),
            // The bill-wide discount stays (capped by the smaller total)
            discountAmount: Math.max(0, roundMoney(Number(bill.DiscountAmount) - itemDiscounts)),
            gstPercentage: billGstPct
        });
        return "items-removed";
    }

    /**
     * A bill staff add on the billing page for a patient, with no appointment behind it. It starts as a
     * Draft like an appointment bill, and its totals are worked out by the same code as an edit.
     */
    async createManualBill(data: {
        patientId: string;
        hospitalId: number;
        providerId?: string | null;
        items: Parameters<AppointmentBillRepository["updateBillDetails"]>[1]["items"];
        discountAmount: number;
        notes?: string;
        gstPercentage?: number;
    }): Promise<AppointmentBill> {
        if (!Array.isArray(data.items) || data.items.length === 0) {
            throw new Error("A bill must have at least one item.");
        }
        if (data.items.some(it => !String(it.itemName || "").trim())) {
            throw new Error("Every item needs a name.");
        }

        const bill = await this.repo.save(this.repo.create({
            AppointmentBillId: uuidv4(),
            AppointmentId: null,
            PatientId: data.patientId,
            ProviderId: data.providerId || null,
            HospitalId: data.hospitalId,
            BillNumber: `DFT-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`,
            BillType: "Manual",
            BillStatus: "Draft",
            AddConsultationFee: false,
            SubTotal: 0,
            DiscountAmount: 0,
            GstAmount: 0,
            CgstAmount: 0,
            SgstAmount: 0,
            IgstAmount: 0,
            TotalAmount: 0,
            PaidAmount: 0,
            DueAmount: 0,
            CreatedAt: new Date()
        }));

        try {
            return await this.updateBillDetails(bill.AppointmentBillId, {
                items: data.items.map(it => ({ ...it, itemName: String(it.itemName).trim(), itemType: it.itemType || "Custom", appointmentId: null })),
                discountAmount: data.discountAmount,
                notes: data.notes,
                gstPercentage: data.gstPercentage
            });
        } catch (err) {
            // Nothing else points at the empty bill just saved, so it is removed rather than left behind
            await this.repo.delete(bill.AppointmentBillId);
            throw err;
        }
    }
}

export const appointmentBillRepository = new AppointmentBillRepository();
