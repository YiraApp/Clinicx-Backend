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

    const tablesToCheck = [
        'DefaultOrganizations',
        'AppVersions',
        'UserDevices',
        'MeetingRedirections',
        'OfferBanners',
        'PushCampaigns',
        'ConsentTemplateFields',
        'Feedbacks',
        'PasswordResetTokens',
        'PatientAccessConsents',
        'DoctorSuggestions',
        'PatientFitnessData'
    ];

    console.log("--- Checking specific tables in Prod ---");
    for (const t of tablesToCheck) {
        const res = await prodDs.query(`SELECT OBJECT_ID('${t}') AS ObjId`);
        console.log(`Table ${t}: ${res[0].ObjId ? 'EXISTS' : 'DOES NOT EXIST'}`);
    }

    const columnsToCheck = [
        { table: 'Users', col: 'LatestOrgId' },
        { table: 'Users', col: 'LatestHospitalId' },
        { table: 'Users', col: 'LatestRoleId' },
        { table: 'Users', col: 'Height' },
        { table: 'Users', col: 'Weight' },
        { table: 'Users', col: 'IsDeleted' },
        { table: 'Users', col: 'Status' },
        { table: 'ConsentRequests', col: 'SignedPdfUrl' },
        { table: 'ConsentRequests', col: 'SignatureImageUrl' },
        { table: 'AppointmentBillItems', col: 'AppointmentId' },
        { table: 'UserRegistrationLinks', col: 'PatientName' },
        { table: 'PostVisitDocuments', col: 'SmsSentCount' },
        { table: 'PostVisitDocuments', col: 'WhatsAppSentCount' },
        { table: 'PostVisitDocuments', col: 'EmailSentCount' }
    ];

    console.log("\n--- Checking specific columns in Prod ---");
    for (const c of columnsToCheck) {
        const res = await prodDs.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_NAME = '${c.table}' AND COLUMN_NAME = '${c.col}'
        `);
        console.log(`${c.table}.${c.col}: ${res.length > 0 ? 'EXISTS' : 'DOES NOT EXIST'}`);
    }

    await prodDs.destroy();
}

main().catch(console.error);
