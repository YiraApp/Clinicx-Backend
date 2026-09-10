import { AppDataSource } from "../src/config/database.ts";
import { UserDevice } from "../src/models/Account/userdevice.model.ts";

async function checkDevices() {
    try {
        await AppDataSource.initialize();
        const repo = AppDataSource.getRepository(UserDevice);
        const devices = await repo.find({ take: 20 });

        console.log(`Found ${devices.length} devices in UserDevices:`);
        devices.forEach(d => {
            console.log(`- ID: ${d.Id}, UserId: ${d.UserId}, Platform: ${d.Platform}, Active: ${d.IsActive}, Token: ${d.DeviceToken?.substring(0, 25)}... (Length: ${d.DeviceToken?.length})`);
        });

        await AppDataSource.destroy();
    } catch (e: any) {
        console.error("FAILED TO CHECK DEVICES:", e.message, e.stack);
    }
}

checkDevices();
