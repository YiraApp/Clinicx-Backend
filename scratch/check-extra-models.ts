import { DataSource } from "typeorm";

async function main() {
    const prodDs = new DataSource({
        type: "mssql",
        host: "yira-clinicx.database.windows.net",
        port: 1433,
        username: "yira-clinicx",
        password: "YrA!Db$92SecureX",
        database: "Clinicx_Prod",
        options: { encrypt: true, trustServerCertificate: true }
    });

    await prodDs.initialize();

    const dsCols = await prodDs.query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'DoctorSuggestions'");
    const fitCols = await prodDs.query("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'PatientFitnessData'");

    console.log("Prod DoctorSuggestions cols count:", dsCols.length);
    console.log("Prod PatientFitnessData cols count:", fitCols.length);

    await prodDs.destroy();
}

main().catch(console.error);
