import { AppDataSource } from "../../../config/database.js";
import { User } from "../../../models/Account/user.model.js";
import { UserRole } from "../../../models/Account/userrole.model.js";

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
     * Saves user updates (such as LastLoginTime).
     */
    async saveUser(user: User): Promise<User> {
        return await this.userRepo.save(user);
    }
}

export const mobileAuthRepository = new MobileAuthRepository();
