import "reflect-metadata";
import { AppDataSource } from "../src/config/database.js";
import { mobileDashboardService } from "../src/MobileApi/v1/services/provider/mobile-dashboard.service.js";
import { patientRegistrationService } from "../src/services/Organizations/patient-registration.service.js";

async function run() {
    await AppDataSource.initialize();
    console.log("Database initialized.");

    const doctorId = "6CDE8235-B520-4442-B912-9622A9D357D0";
    const hospId = 19;
    const orgId = 1;

    // 1. Web query
    const webRes = await patientRegistrationService.getOrgHospPatients(1, 100, {
        hospitalId: hospId,
        organizationId: orgId,
        doctorId: doctorId
    });
    const webPatients = webRes?.data?.data || webRes?.patients || [];
    console.log(`WEB PATIENTS (${webPatients.length} total):`);

    // 2. Mobile query
    const mobileRes = await mobileDashboardService.getPatientsList(
        doctorId,
        orgId,
        hospId,
        { page: 1, pageSize: 100 }
    );
    const mobilePatients = mobileRes?.patients || [];
    console.log(`MOBILE PATIENTS (${mobilePatients.length} total):`);

    // Compare
    const webMap = new Map(webPatients.map(p => [(p.userId || p.id).toUpperCase(), p]));
    const mobileMap = new Map(mobilePatients.map(p => [(p.userId || p.id).toUpperCase(), p]));

    console.log(`\n--- COMPARISON ---`);
    let missingInMobile = 0;
    for (const [id, p] of webMap.entries()) {
        if (!mobileMap.has(id)) {
            console.log(`>>> MISSING IN MOBILE: ${id} - ${p.name || p.fullName || p.firstName}`);
            missingInMobile++;
        }
    }

    let extraInMobile = 0;
    for (const [id, p] of mobileMap.entries()) {
        if (!webMap.has(id)) {
            console.log(`>>> IN MOBILE BUT NOT IN WEB: ${id} - ${p.name}`);
            extraInMobile++;
        }
    }

    if (missingInMobile === 0 && extraInMobile === 0) {
        console.log(`SUCCESS! EXACT MATCH! Both Web and Mobile have identical ${webPatients.length} patients!`);
    }

    await AppDataSource.destroy();
}

run().catch(console.error);
