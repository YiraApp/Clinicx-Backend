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

    await qaDs.initialize();

    const tables = [
        'ConsentTemplateFields',
        'Feedbacks',
        'OfferBanners',
        'PasswordResetTokens',
        'PatientAccessConsents',
        'PushCampaigns'
    ];

    const fks = await qaDs.query(`
        SELECT 
            tp.name AS ParentTable,
            cp.name AS ParentColumn,
            tr.name AS ReferencedTable,
            cr.name AS ReferencedColumn,
            fk.name AS ForeignKeyName
        FROM sys.foreign_keys fk
        INNER JOIN sys.tables tp ON fk.parent_object_id = tp.object_id
        INNER JOIN sys.tables tr ON fk.referenced_object_id = tr.object_id
        INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        INNER JOIN sys.columns cp ON fkc.parent_column_id = cp.column_id AND fkc.parent_object_id = cp.object_id
        INNER JOIN sys.columns cr ON fkc.referenced_column_id = cr.column_id AND fkc.referenced_object_id = cr.object_id
        WHERE tp.name IN ('${tables.join("','")}')
    `);

    console.log("Foreign keys on missing tables:", fks);

    await qaDs.destroy();
}

main().catch(console.error);
