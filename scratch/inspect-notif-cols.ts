import { AppDataSource } from "../src/config/database.js";

async function checkColumns() {
    try {
        await AppDataSource.initialize();
        const queryRunner = AppDataSource.createQueryRunner();
        const table = await queryRunner.getTable("AppNotifications");
        console.log("AppNotifications Columns:", table?.columns.map(c => ({
            name: c.name,
            type: c.type,
            isNullable: c.isNullable
        })));
        await queryRunner.release();
        process.exit(0);
    } catch (e) {
        console.error("Error inspecting columns:", e);
        process.exit(1);
    }
}

checkColumns();
