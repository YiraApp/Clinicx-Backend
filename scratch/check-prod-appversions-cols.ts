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

    const cols = await prodDs.query(`
        SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'AppVersions'
    `);
    console.log("Prod AppVersions columns:", cols);

    await prodDs.destroy();
}

main().catch(console.error);
