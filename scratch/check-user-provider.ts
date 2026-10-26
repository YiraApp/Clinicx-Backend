import { AppDataSource } from "../src/config/database.js";

async function run() {
    try {
        await AppDataSource.initialize();
        const users = await AppDataSource.query(`
            SELECT Id, FirstName, LastName, PhoneNumber, Email, Status, IsDeleted, LatestRoleId, LatestHospitalId, LatestOrgId 
            FROM Users 
            WHERE PhoneNumber LIKE '%9908875796%' OR Email LIKE '%neelimanikanta%'
        `);
        console.log("=== USERS ===");
        console.log(JSON.stringify(users, null, 2));

        for (const u of users) {
            console.log(`\n=== USER ROLES for ${u.Id} (${u.FirstName} ${u.LastName}) ===`);
            const roles = await AppDataSource.query(`
                SELECT ur.*, r.RoleName, r.NormalizedName 
                FROM UserRoles ur
                LEFT JOIN Roles r ON ur.RoleId = r.Id
                WHERE ur.UserId = '${u.Id}'
            `);
            console.log(JSON.stringify(roles, null, 2));

            console.log(`\n=== HEALTHCARE PROVIDERS for ${u.Id} ===`);
            const providers = await AppDataSource.query(`
                SELECT hp.*, h.Name as HospitalName 
                FROM HealthcareProviders hp
                LEFT JOIN Hospitals h ON hp.HospitalId = h.Id
                WHERE hp.UserId = '${u.Id}'
            `);
            console.log(JSON.stringify(providers, null, 2));
        }

        // Also check hospital 2 doctors
        console.log("\n=== ALL HEALTHCARE PROVIDERS IN HOSPITAL 2 ===");
        const hosp2Docs = await AppDataSource.query(`
            SELECT hp.Id, hp.UserId, hp.HospitalId, hp.Status, hp.IsDeleted, hp.Specialty, u.FirstName, u.LastName, u.PhoneNumber, u.Email, u.Status as UserStatus, u.IsDeleted as UserDeleted
            FROM HealthcareProviders hp
            LEFT JOIN Users u ON hp.UserId = u.Id
            WHERE hp.HospitalId = 2
        `);
        console.log(JSON.stringify(hosp2Docs, null, 2));

        process.exit(0);
    } catch (e) {
        console.error("Error:", e);
        process.exit(1);
    }
}

run();
