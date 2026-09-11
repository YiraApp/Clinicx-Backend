import { sendFcmPushToTokens, initFirebaseAdmin } from "../src/services/Notifications/firebase-admin.service.ts";
import { AppDataSource } from "../src/config/database.ts";
import { UserDevice } from "../src/models/Account/userdevice.model.ts";

async function testSend() {
    console.log("Testing Firebase Admin initialization...");
    const initialized = initFirebaseAdmin();
    console.log("Firebase initialized:", initialized);

    await AppDataSource.initialize();
    const repo = AppDataSource.getRepository(UserDevice);
    const devices = await repo.find({ where: { IsActive: true } });
    console.log(`Found ${devices.length} active devices.`);

    const tokens = devices.map(d => d.FCMToken).filter(t => !!t && t.length > 15);
    console.log(`Tokens found (${tokens.length}):`, tokens.map(t => t.substring(0, 20) + "..."));

    const realTokens = tokens.filter(t => 
        !t.startsWith("test_") && 
        !t.startsWith("placeholder") && 
        !t.startsWith("ios_sim") && 
        !t.startsWith("ios_device")
    );

    console.log(`Real device tokens found (${realTokens.length}):`);
    realTokens.forEach(t => console.log(` - ${t.substring(0, 30)}... (length: ${t.length})`));

        console.log("\nAttempting to send push with rich image to all genuine tokens...");
        const res = await sendFcmPushToTokens(realTokens, {
            title: "50% Off Full Body Checkup! 🏥",
            body: "Includes 65+ vital blood and health parameters. Book today!",
            imageUrl: "https://clinicxstorage.blob.core.windows.net/banners/full-body-health-checkup.jpg",
            type: "OFFER_PROMOTION",
            route: "/patientDashboard"
        });
        console.log("\nSend result summary:", res);

    await AppDataSource.destroy();
}

testSend().catch(console.error);
