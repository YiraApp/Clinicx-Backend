import { AppDataSource } from "../src/config/database.ts";
import { UserDevice } from "../src/models/Account/userdevice.model.ts";
import { User } from "../src/models/Account/user.model.ts";

async function inspectUsers() {
    await AppDataSource.initialize();
    const deviceRepo = AppDataSource.getRepository(UserDevice);
    const userRepo = AppDataSource.getRepository(User);

    const devices = await deviceRepo.find({ where: { IsActive: true }, order: { UpdatedAt: "DESC" } });
    console.log(`=== ACTIVE DEVICES & ASSOCIATED USERS (${devices.length}) ===`);

    for (const d of devices) {
        const user = await userRepo.findOne({ where: { Id: d.UserId } });
        const userName = user ? `${user.FirstName || ''} ${user.LastName || ''} (${user.Phone || user.Email})` : "Unknown User";
        console.log(`Device ID ${d.Id}:
  Platform: ${d.Platform}
  DeviceId: ${d.PhysicalDeviceId}
  User: ${userName} [${d.UserId}]
  Updated: ${d.UpdatedAt || d.CreatedAt}
  Token: ${d.FCMToken?.substring(0, 35)}... (len: ${d.FCMToken?.length})
`);
    }

    await AppDataSource.destroy();
}

inspectUsers().catch(console.error);
