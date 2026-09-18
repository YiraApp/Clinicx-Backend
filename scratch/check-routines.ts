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

    const qaRoutines = await qaDs.query(`
        SELECT ROUTINE_NAME, ROUTINE_TYPE 
        FROM INFORMATION_SCHEMA.ROUTINES
    `);

    const prodRoutines = await prodDs.query(`
        SELECT ROUTINE_NAME, ROUTINE_TYPE 
        FROM INFORMATION_SCHEMA.ROUTINES
    `);

    console.log("QA Routines:", qaRoutines);
    console.log("Prod Routines:", prodRoutines);

    await qaDs.destroy();
    await prodDs.destroy();
}

main().catch(console.error);
