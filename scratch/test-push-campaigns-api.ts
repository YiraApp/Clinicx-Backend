import axios from "axios";

async function main() {
    console.log("=== TESTING PUSH NOTIFICATIONS API (http://localhost:5000/api/push-campaigns) ===\n");

    const baseUrl = "http://localhost:5000/api/push-campaigns";

    // 1. Create a Continuous recurring notification (Daily 9:00 AM, Text-only, Without Image)
    console.log("1. Creating Continuous Daily Notification (Without Image)...");
    const continuousPayload = {
        title: "Daily Morning Health Tip ☀️",
        body: "Drink 2 glasses of warm water every morning on an empty stomach to boost metabolism and improve digestion!",
        hasImage: false,
        imageUrl: null,
        scheduleType: "recurring",
        scheduledTime: "09:00",
        recurringPattern: "daily",
        redirectionType: "in_app",
        inAppRoute: "/patientDashboard",
        isAllOrganizations: true,
        notificationCategory: "health_tips",
        isActive: true,
    };

    const createRes1 = await axios.post(baseUrl, continuousPayload);
    console.log("-> Continuous Created:", createRes1.data.data.id, createRes1.data.data.title);

    // 2. Create a Scheduled notification (Specific Date & Time, With Image)
    console.log("\n2. Creating Scheduled Date & Time Notification (With Image)...");
    const scheduledPayload = {
        title: "50% Off Full Body Checkup - This Sunday Only! 🏥",
        body: "Comprehensive package including 65+ tests. Fast results within 24 hours. Book your home sample collection now!",
        hasImage: true,
        imageUrl: "https://clinicxstorage.blob.core.windows.net/banners/full-body-health-checkup.jpg",
        scheduleType: "scheduled",
        scheduledDate: "2026-09-15",
        scheduledTime: "10:00",
        redirectionType: "browser",
        redirectionUrl: "https://yirahealth.com/special-checkup-package",
        isAllOrganizations: true,
        notificationCategory: "promotions",
        isActive: true,
    };

    const createRes2 = await axios.post(baseUrl, scheduledPayload);
    console.log("-> Scheduled Created:", createRes2.data.data.id, createRes2.data.data.title);

    // 3. Fetch all campaigns
    console.log("\n3. Fetching all push campaigns...");
    const listRes = await axios.get(baseUrl);
    console.log(`-> Retrieved ${listRes.data.data.length} push campaigns from DB:`);
    listRes.data.data.forEach((c: any) => {
        console.log(`   - [ID: ${c.id}] [Type: ${(c.scheduleType || '').toUpperCase()}] [Media: ${c.hasImage ? 'WITH IMAGE' : 'TEXT ONLY'}] [Status: ${c.status}] ${c.title}`);
    });

    // 4. Test Instant Dispatch of campaign 1
    console.log(`\n4. Testing instant dispatch of campaign ID ${createRes1.data.data.id}...`);
    try {
        const sendRes = await axios.post(`${baseUrl}/${createRes1.data.data.id}/send`);
        console.log("-> Dispatch Response:", sendRes.data);
    } catch (err: any) {
        console.log("-> Dispatch Response/Notice:", err.response?.data || err.message);
    }

    console.log("\n=== ALL API CHECKS COMPLETED SUCCESSFULLY ===");
}

main().catch(err => {
    console.error("Test failed:", err.response?.data || err.message);
    process.exit(1);
});
