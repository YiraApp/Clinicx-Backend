import { DataSource } from "typeorm";
import dotenv from "dotenv";
dotenv.config();

async function testConnection(name: string, host: string, user: string, pass: string, db: string) {
    console.log(`\n--- Testing ${name} Database ---`);
    console.log(`Host: ${host}, DB: ${db}, User: ${user}`);
    const ds = new DataSource({
        type: "mssql",
        host,
        port: 1433,
        username: user,
        password: pass,
        database: db,
        options: {
            encrypt: true,
            trustServerCertificate: true,
            connectTimeout: 10000,
        }
    });

    try {
        await ds.initialize();
        console.log(`✅ Connection to ${name} SUCCESSFUL!`);
        const result = await ds.query("SELECT DB_NAME() AS CurrentDB, @@VERSION AS Version");
        console.log("Details:", result);
        await ds.destroy();
        return true;
    } catch (err: any) {
        console.log(`❌ Connection to ${name} FAILED:`, err.message);
        return false;
    }
}

async function main() {
    // QA / Dev DB
    const qaOk = await testConnection(
        "QA / Dev",
        process.env.DB_HOST || "yiralifesqldev.database.windows.net",
        process.env.DB_USER || "yirauserdev",
        process.env.DB_PASSWORD || "P@ssw0rd01",
        process.env.DB_NAME || "ClinicX"
    );

    // Prod DB
    const prodOk = await testConnection(
        "Production",
        "yira-clinicx.database.windows.net",
        "yira-clinicx",
        "YrA!Db$92SecureX",
        "Clinicx_Prod"
    );

    console.log("\nSummary:");
    console.log("QA Accessible:", qaOk);
    console.log("Prod Accessible:", prodOk);
    process.exit(0);
}

main();
