import { AppDataSource } from "../src/config/database.js";
import { AppointmentBill } from "../src/models/Payments/appointment-bill.model.js";

async function run() {
    await AppDataSource.initialize();
    const billRepo = AppDataSource.getRepository(AppointmentBill);

    const bills = await billRepo.find({
        where: { IsDeleted: false }
    });

    for (const b of bills) {
        const gst = Number(b.GstAmount || 0);
        const cgst = Number(b.CgstAmount || 0);
        const sgst = Number(b.SgstAmount || 0);
        const igst = Number(b.IgstAmount || 0);

        // If corrupted by the / 3 split
        if (gst > 0 && Math.abs((cgst + sgst + igst) - gst) < 0.1 && cgst > 0 && igst > 0) {
            const half = parseFloat((gst / 2).toFixed(2));
            const otherHalf = parseFloat((gst - half).toFixed(2));
            await billRepo.update(b.AppointmentBillId, {
                CgstAmount: half,
                SgstAmount: otherHalf,
                IgstAmount: 0
            });
            console.log(`Fixed bill ${b.BillNumber}: CGST ${half}, SGST ${otherHalf}, IGST 0`);
        }
    }

    console.log("Database bill cleanup complete.");
    await AppDataSource.destroy();
}

run().catch(console.error);
