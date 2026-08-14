import { AppDataSource } from "../src/config/database.js";
import { User } from "../src/models/Account/user.model.js";
import { UserRole } from "../src/models/Account/userrole.model.js";

async function main() {
    await AppDataSource.initialize();
    console.log("DB Connected successfully!");

    const userRepo = AppDataSource.getRepository(User);
    const userRoleRepo = AppDataSource.getRepository(UserRole);
    const phoneNumber = "6303012453";
    
    // Fetch all users to look for the phone number
    const users = await userRepo.find();
    
    const matchedUsers = users.filter(u => u.PhoneNumber && u.PhoneNumber.includes(phoneNumber));
    console.log(`\nMatched users for phone '${phoneNumber}':`);
    if (matchedUsers.length === 0) {
        console.log("No users found matching this phone number.");
    } else {
        for (const u of matchedUsers) {
            console.log("User details:", {
                Id: u.Id,
                FirstName: u.FirstName,
                LastName: u.LastName,
                Email: u.Email,
                PhoneNumber: u.PhoneNumber,
                IsPrimary: u.IsPrimary,
                IsDeleted: u.IsDeleted,
                Status: u.Status
            });

            // Fetch user roles
            const roles = await userRoleRepo.find({
                where: { UserId: u.Id },
                relations: ["Role"]
            });
            console.log("Roles assigned to user:");
            roles.forEach(r => {
                console.log({
                    RoleId: r.RoleId,
                    RoleName: r.Role?.RoleName,
                    Status: r.Status,
                    IsDeleted: r.IsDeleted
                });
            });
        }
    }

    await AppDataSource.destroy();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
