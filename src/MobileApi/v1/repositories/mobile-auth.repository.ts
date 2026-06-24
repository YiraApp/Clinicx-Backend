import { AppDataSource } from "../../../config/database.js";
import { User } from "../../../models/Account/user.model.js";
import { UserRole } from "../../../models/Account/userrole.model.js";
import { Hospital } from "../../../models/Organizations/hospital.model.js";

export class MobileAuthRepository {
    private userRepo = AppDataSource.getRepository(User);
    private userRoleRepo = AppDataSource.getRepository(UserRole);

    /**
     * Finds a primary user by email or phone number.
     */
    async findPrimaryUser(identity: string): Promise<User | null> {
        return await this.userRepo.findOne({
            where: [
                { Email: identity, IsPrimary: true, IsDeleted: false },
                { PhoneNumber: identity, IsPrimary: true, IsDeleted: false }
            ]
        });
    }

    /**
     * Fetches all active roles for the specified user ID.
     */
    async findUserRoles(userId: string): Promise<UserRole[]> {
        return await this.userRoleRepo.find({
            where: { UserId: userId, IsDeleted: false, Status: true },
            relations: ["Role", "Organization", "Hospital"]
        });
    }

    /**
     * Fetches all active roles for the specified user ID and role ID.
     */
    async findUserRolesByRole(userId: string, roleId: string): Promise<UserRole[]> {
        return await this.userRoleRepo.find({
            where: { UserId: userId, RoleId: roleId, IsDeleted: false, Status: true },
            relations: ["Role", "Organization", "Hospital"]
        });
    }

    /**
     * Fetches all active hospitals under a given organization.
     */
    async findHospitalsByOrganization(orgId: number): Promise<Hospital[]> {
        return await AppDataSource.getRepository(Hospital).find({
            where: { OrganizationId: orgId, IsDeleted: false, Status: true }
        });
    }

    /**
     * Saves user updates (such as LastLoginTime).
     */
    async saveUser(user: User): Promise<User> {
        return await this.userRepo.save(user);
    }
}

export const mobileAuthRepository = new MobileAuthRepository();
