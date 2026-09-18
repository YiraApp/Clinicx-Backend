import { DataSource } from "typeorm";

async function main() {
    const qaDs = new DataSource({
        type: "mssql",
        host: "yiralifesqldev.database.windows.net",
        port: 1433,
        username: "yirauserdev",
        password: "P@ssw0rd01",
        database: "ClinicX",
        options: { encrypt: true, trustServerCertificate: true }
    });

    const prodDs = new DataSource({
        type: "mssql",
        host: "yira-clinicx.database.windows.net",
        port: 1433,
        username: "yira-clinicx",
        password: "YrA!Db$92SecureX",
        database: "Clinicx_Prod",
        options: { encrypt: true, trustServerCertificate: true }
    });

    await qaDs.initialize();
    await prodDs.initialize();

    console.log("\n=== QA DefaultOrganizations ===");
    console.log(await qaDs.query("SELECT * FROM DefaultOrganizations"));

    console.log("\n=== Prod DefaultOrganizations ===");
    console.log(await prodDs.query("SELECT * FROM DefaultOrganizations"));

    console.log("\n=== QA AppVersions ===");
    console.log(await qaDs.query("SELECT * FROM AppVersions"));

    console.log("\n=== Prod AppVersions ===");
    console.log(await prodDs.query("SELECT * FROM AppVersions"));

    await qaDs.destroy();
    await prodDs.destroy();
}

main().catch(console.error);
