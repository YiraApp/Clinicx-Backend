import { AppDataSource } from './src/config/database.js';

async function check() {
    await AppDataSource.initialize();
    const rows = await AppDataSource.query(`
        SELECT Id, Title, Type, CreatedAt,
               CONVERT(varchar, CreatedAt, 120) as CreatedAtStr
        FROM AppNotifications
        WHERE CreatedAt >= '2026-09-09 00:00:00'
        ORDER BY CreatedAt DESC
    `);
    console.log('Today rows count:', rows.length);
    for (const r of rows) {
        console.log(r);
    }
    process.exit(0);
}

check();
