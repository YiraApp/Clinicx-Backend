import { DataSource } from "typeorm";
import fs from "fs";

async function getDbMetadata(ds: DataSource) {
    // Get all user tables
    const tables = await ds.query(`
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
    `);

    // Get all columns
    const columns = await ds.query(`
        SELECT 
            TABLE_NAME, 
            COLUMN_NAME, 
            DATA_TYPE, 
            CHARACTER_MAXIMUM_LENGTH, 
            IS_NULLABLE, 
            COLUMN_DEFAULT,
            NUMERIC_PRECISION,
            NUMERIC_SCALE
        FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);

    return {
        tables: new Set<string>(tables.map((t: any) => t.TABLE_NAME)),
        columns: columns
    };
}

async function main() {
    console.log("Connecting to QA and Prod...");
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

    console.log("Fetching metadata...");
    const qaMeta = await getDbMetadata(qaDs);
    const prodMeta = await getDbMetadata(prodDs);

    // 1. Missing Tables in Prod
    const missingTablesInProd: string[] = [];
    for (const tbl of qaMeta.tables) {
        if (!prodMeta.tables.has(tbl)) {
            missingTablesInProd.push(tbl);
        }
    }

    console.log(`\nFound ${missingTablesInProd.length} tables in QA that do NOT exist in Prod:`);
    console.log(missingTablesInProd);

    // 2. Missing Columns in Prod (for tables that exist in both)
    const prodColMap = new Map<string, any>();
    for (const c of prodMeta.columns) {
        prodColMap.set(`${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase(), c);
    }

    const missingColumnsInProd: any[] = [];
    for (const c of qaMeta.columns) {
        // Only check tables that exist in Prod
        if (prodMeta.tables.has(c.TABLE_NAME)) {
            const key = `${c.TABLE_NAME}.${c.COLUMN_NAME}`.toLowerCase();
            if (!prodColMap.has(key)) {
                missingColumnsInProd.push(c);
            }
        }
    }

    console.log(`\nFound ${missingColumnsInProd.length} columns in QA that do NOT exist in Prod (in existing tables):`);
    for (const c of missingColumnsInProd) {
        console.log(`- ${c.TABLE_NAME}.${c.COLUMN_NAME} (${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : c.CHARACTER_MAXIMUM_LENGTH})` : ''})`);
    }

    // Save results to a file for analysis
    fs.writeFileSync("scratch/diff_report.json", JSON.stringify({
        missingTablesInProd,
        missingColumnsInProd
    }, null, 2));

    await qaDs.destroy();
    await prodDs.destroy();
}

main().catch(err => {
    console.error("Comparison error:", err);
    process.exit(1);
});
