import { AppDataSource } from "../src/config/database.js";
import { HospitalPaymentConfiguration } from "../src/models/Organizations/hospital-payment-configuration.model.js";

async function main() {
    await AppDataSource.initialize();
    const configRepo = AppDataSource.getRepository(HospitalPaymentConfiguration);
    const configs = await configRepo.find();
    console.log("Configs:", JSON.stringify(configs, null, 2));

    const paymentsRepo = AppDataSource.getRepository("Payments");
    const payments = await paymentsRepo.find({ order: { CreatedAt: "DESC" }, take: 5 });
    console.log("Recent Payments:", JSON.stringify(payments, null, 2));

    const billsRepo = AppDataSource.getRepository("AppointmentBills");
    const bills = await billsRepo.find({ order: { CreatedAt: "DESC" }, take: 5 });
    console.log("Recent Bills:", JSON.stringify(bills, null, 2));

    process.exit(0);
}

main().catch(console.error);
