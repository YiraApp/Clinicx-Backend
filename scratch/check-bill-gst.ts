import { AppDataSource } from "../src/config/database.js";
import { AppointmentBill } from "../src/models/Payments/appointment-bill.model.js";
import { HospitalPaymentConfiguration } from "../src/models/Organizations/hospital-payment-configuration.model.js";

async function run() {
    await AppDataSource.initialize();
    const billRepo = AppDataSource.getRepository(AppointmentBill);
    const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);

    const bills = await billRepo.find({
        order: { CreatedAt: "DESC" },
        take: 5,
        relations: ["BillItems"]
    });

    console.log("RECENT BILLS:");
    for (const b of bills) {
        console.log({
            id: b.AppointmentBillId,
            billNumber: b.BillNumber,
            total: b.TotalAmount,
            subTotal: b.SubTotal,
            gstAmount: b.GstAmount,
            cgst: b.CgstAmount,
            sgst: b.SgstAmount,
            igst: b.IgstAmount,
            items: b.BillItems?.map(i => ({ name: i.ItemName, price: i.UnitPrice, gstAmt: i.GstAmount, gstPct: i.GstPercentage }))
        });
    }

    const configs = await configRepo.find();
    console.log("CONFIGS:", configs);
    await AppDataSource.destroy();
}

run().catch(console.error);
