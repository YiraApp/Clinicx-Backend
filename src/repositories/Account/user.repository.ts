import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import type { IUserRepository } from "../../interfaces/Repository/Account/IUserRepository.js";

/**
 * Repository implementation for User entity.
 */
export class UserRepository implements IUserRepository {
    private repo = AppDataSource.getRepository(User);

    async findPrimaryByPhone(phone: string): Promise<User | null> {
        return await this.repo.findOne({
            where: { PhoneNumber: phone, IsPrimary: true, IsDeleted: false }
        });
    }

    async countUsersByPhone(phone: string): Promise<number> {
        return await this.repo.count({
            where: { PhoneNumber: phone, IsDeleted: false }
        });
    }

    async findById(id: string): Promise<User | null> {
        return await this.repo.findOne({
            where: { Id: id, IsDeleted: false }
        });
    }

    async findByEmail(email: string): Promise<User | null> {
        return await this.repo.findOne({
            where: { Email: email, IsDeleted: false }
        });
    }

    async save(user: User): Promise<User> {
        return await this.repo.save(user);
    }
}

export const userRepository = new UserRepository();
