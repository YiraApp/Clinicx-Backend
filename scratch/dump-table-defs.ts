import { DataSource } from "typeorm";
import fs from "fs";

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

    await qaDs.initialize();

    const tables = [
        'ConsentTemplateFields',
        'Feedbacks',
        'OfferBanners',
        'PasswordResetTokens',
        'PatientAccessConsents',
        'PushCampaigns'
    ];

    const results: any = {};

    for (const t of tables) {
        // Columns
        const cols = await qaDs.query(`
            SELECT 
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.CHARACTER_MAXIMUM_LENGTH,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                COLUMNPROPERTY(OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') as IsIdentity
            FROM INFORMATION_SCHEMA.COLUMNS c
            WHERE c.TABLE_NAME = '${t}'
            ORDER BY c.ORDINAL_POSITION
        `);

        // Primary keys
        const pks = await qaDs.query(`
            SELECT kcu.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
              AND tc.TABLE_NAME = '${t}'
        `);

        results[t] = { cols, pks };
    }

    fs.writeFileSync("scratch/missing_tables_def.json", JSON.stringify(results, null, 2));
    console.log("Dumped definitions for missing tables successfully.");
    await qaDs.destroy();
}

main().catch(console.error);
