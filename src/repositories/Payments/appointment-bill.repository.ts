import { AppDataSource } from "../../config/database.js";
import { AppointmentBill } from "../../models/Payments/appointment-bill.model.js";
import { AppointmentBillItem } from "../../models/Payments/appointment-bill-item.model.js";
import { HospitalPaymentConfiguration } from "../../models/Organizations/hospital-payment-configuration.model.js";
import { TreatmentPlan } from "../../models/Payments/treatment-plan.model.js";
import { Payment } from "../../models/Payments/payment.model.js";
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
            const totalItemAmt = data.consultationFee;
            const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
            const gst = parseFloat((totalItemAmt - sub).toFixed(2));
            subTotalSum += sub;

            itemsToCreate.push({
                ItemType: "Consultation",
                ItemName: "Consultation Fee",
                Quantity: 1,
                UnitPrice: sub,
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
                const totalItemAmt = plan.Amount;
                const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
                const gst = parseFloat((totalItemAmt - sub).toFixed(2));
                subTotalSum += sub;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemReferenceId: plan.TreatmentPlanId,
                    ItemName: plan.Name,
                    Quantity: 1,
                    UnitPrice: sub,
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
                const totalItemAmt = cp.amount;
                const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
                const gst = parseFloat((totalItemAmt - sub).toFixed(2));
                subTotalSum += sub;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemName: cp.name,
                    Quantity: 1,
                    UnitPrice: sub,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        // 4. NO bill number yet — bill starts as Draft
        const overallDiscount = Number(data.discountAmount) || 0;
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
            const totalItemAmt = data.consultationFee;
            const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
            const gst = parseFloat((totalItemAmt - sub).toFixed(2));
            subTotalSum += sub;

            itemsToCreate.push({
                ItemType: "Consultation",
                ItemName: "Consultation Fee (Follow-up)",
                Quantity: 1,
                UnitPrice: sub,
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
                const totalItemAmt = plan.Amount;
                const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
                const gst = parseFloat((totalItemAmt - sub).toFixed(2));
                subTotalSum += sub;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemReferenceId: plan.TreatmentPlanId,
                    ItemName: plan.Name,
                    Quantity: 1,
                    UnitPrice: sub,
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
                const totalItemAmt = cp.amount;
                const sub = parseFloat((totalItemAmt / (1 + (gstPct / 100))).toFixed(2));
                const gst = parseFloat((totalItemAmt - sub).toFixed(2));
                subTotalSum += sub;

                itemsToCreate.push({
                    ItemType: "TreatmentPlan",
                    ItemName: cp.name,
                    Quantity: 1,
                    UnitPrice: sub,
                    DiscountAmount: 0,
                    GstPercentage: gstPct,
                    GstAmount: gst,
                    TotalAmount: totalItemAmt
                });
            }
        }

        const newDiscount = (Number(bill.DiscountAmount) || 0) + (Number(data.discountAmount) || 0);
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
            DueAmount: dueAmount,
            BillStatus: dueAmount <= 0 ? "Paid" : (Number(bill.PaidAmount) > 0 ? "PartiallyPaid" : "Pending"),
            UpdatedAt: new Date()
        });

        return bill;
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
            .leftJoinAndSelect("appointment.Doctor", "doctor")
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

        const { Appointment } = await import("../../models/Appointments/appointment.model.js");
        const { In } = await import("typeorm/index.js");
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
        const rootBillMap = new Map<number, AppointmentBill>();

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

            if (rootBillMap.has(rootParentId)) {
                const rootBill = rootBillMap.get(rootParentId)!;
                
                // Merge items safely without duplicates
                if (bill.BillItems) {
                    for (const item of bill.BillItems) {
                        const exists = rootBill.BillItems?.some(ri => ri.AppointmentBillItemId === item.AppointmentBillItemId);
                        if (!exists) {
                            rootBill.BillItems = rootBill.BillItems || [];
                            rootBill.BillItems.push(item);
                        }
                    }
                }

                rootBill.SubTotal = parseFloat((Number(rootBill.SubTotal) + Number(bill.SubTotal)).toFixed(2));
                rootBill.DiscountAmount = parseFloat((Number(rootBill.DiscountAmount) + Number(bill.DiscountAmount)).toFixed(2));
                rootBill.GstAmount = parseFloat((Number(rootBill.GstAmount) + Number(bill.GstAmount)).toFixed(2));
                rootBill.CgstAmount = parseFloat((Number(rootBill.CgstAmount) + Number(bill.CgstAmount)).toFixed(2));
                rootBill.SgstAmount = parseFloat((Number(rootBill.SgstAmount) + Number(bill.SgstAmount)).toFixed(2));
                rootBill.IgstAmount = parseFloat((Number(rootBill.IgstAmount) + Number(bill.IgstAmount)).toFixed(2));
                rootBill.TotalAmount = parseFloat((Number(rootBill.TotalAmount) + Number(bill.TotalAmount)).toFixed(2));
                rootBill.PaidAmount = parseFloat((Number(rootBill.PaidAmount) + Number(bill.PaidAmount)).toFixed(2));
                rootBill.DueAmount = parseFloat((Number(rootBill.DueAmount) + Number(bill.DueAmount)).toFixed(2));
                rootBill.BillStatus = rootBill.DueAmount <= 0 ? "Paid" : (rootBill.PaidAmount > 0 ? "PartiallyPaid" : "Pending");
            } else {
                const clone = {
                    ...bill,
                    BillItems: bill.BillItems ? [...bill.BillItems] : []
                } as AppointmentBill;
                rootBillMap.set(rootParentId, clone);
            }
        }

        const consolidatedBills = Array.from(rootBillMap.values()).concat(nonApptBills);

        // Attach appointment chain (parent + child visits) to each consolidated bill
        const payRepo = AppDataSource.getRepository(Payment);
        const billsWithChain = await Promise.all(consolidatedBills.map(async (bill) => {
            if (!bill.AppointmentId) return { ...bill, appointmentChain: [] };

            // Collect the full appointment chain starting from root
            const chain: any[] = [];
            const rootAppt = await appRepo.findOne({
                where: { Id: bill.AppointmentId },
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
            await findChildren(bill.AppointmentId);

            // Fetch items and payments for each visit in the chain
            const enrichedChain = await Promise.all(chain.map(async (appt) => {
                const apptPayments = await payRepo.find({
                    where: { AppointmentId: appt.id }
                });
                
                const apptItems = bill.BillItems ? bill.BillItems.filter(bi => {
                    if (bi.AppointmentId === appt.id) return true;
                    if (!bi.AppointmentId && appt.id === bill.AppointmentId) return true;
                    return false;
                }) : [];

                return {
                    ...appt,
                    items: apptItems.map(item => ({
                        itemName: item.ItemName,
                        itemType: item.ItemType,
                        unitPrice: Number(item.UnitPrice),
                        quantity: Number(item.Quantity),
                        discountAmount: Number(item.DiscountAmount),
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
            }[];
            discountAmount: number; // General bill discount
            notes?: string;
            gstPercentage?: number;
            gstAmount?: number;
        }
    ): Promise<AppointmentBill> {
        return await AppDataSource.transaction(async (manager) => {
            const billRepo = manager.getRepository(AppointmentBill);
            const itemRepo = manager.getRepository(AppointmentBillItem);

            const bill = await billRepo.findOne({
                where: { AppointmentBillId: billId, IsDeleted: false },
                relations: ["BillItems", "Hospital"]
            });
            if (!bill) throw new Error("Bill not found.");
            if (bill.BillStatus === "Paid") {
                throw new Error("Cannot edit a fully paid bill.");
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
                const qty = Number(it.quantity) || 1;
                const price = Number(it.unitPrice) || 0;
                const disc = Number(it.discountAmount) || 0;
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

            // 4. Calculate overall totals
            const overallDiscount = Number(data.discountAmount) || 0;
            const totalDiscount = itemsDiscountSum + overallDiscount;

            // If overall discount is applied, adjust subtotal/total
            const finalTaxable = Math.max(0, (subTotalSum - itemsDiscountSum) - overallDiscount);
            
            // Recalculate tax based on final taxable amount (using the hospital configuration distribution)
            const customGstAmount = data.gstAmount !== undefined && data.gstAmount !== null ? Number(data.gstAmount) : null;
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
                    cgstAmount = parseFloat((customGstAmount / 3).toFixed(2));
                    sgstAmount = parseFloat((customGstAmount / 3).toFixed(2));
                    igstAmount = parseFloat((customGstAmount / 3).toFixed(2));
                }
            } else {
                cgstAmount = parseFloat(((finalTaxable * cgstPct) / 100).toFixed(2));
                sgstAmount = parseFloat(((finalTaxable * sgstPct) / 100).toFixed(2));
                igstAmount = parseFloat(((finalTaxable * igstPct) / 100).toFixed(2));
            }

            const totalAmount = parseFloat((finalTaxable + finalGst).toFixed(2));

            if (totalAmount < Number(bill.PaidAmount)) {
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
                DueAmount: Math.max(0, totalAmount - Number(bill.PaidAmount)),
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
}

export const appointmentBillRepository = new AppointmentBillRepository();
