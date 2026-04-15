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

    async findByPhone(phone: string): Promise<User | null> {
        return await this.repo.findOne({
            where: { PhoneNumber: phone, IsDeleted: false }
        });
    }

    async getUsers(page: number = 1, pageSize: number = 10, filters?: any): Promise<{ data: User[], total: number, page: number, pageSize: number, totalPages: number }> {
        const skip = (page - 1) * pageSize;
        const sortBy = filters?.sortBy || 'CreatedAt';
        const sortOrder = filters?.sortOrder || 'DESC';

        const query = this.repo.createQueryBuilder('u')
            .where('u.IsDeleted = :isDeleted', { isDeleted: false });

        // Search filter - search by FirstName, LastName, Email, or PhoneNumber
        if (filters?.search) {
            query.andWhere(
                '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                { search: `%${filters.search}%` }
            );
        }

        // Status filter
        if (filters?.status !== undefined) {
            query.andWhere('u.Status = :status', { status: filters.status });
        }

        // Date range filter
        if (filters?.fromDate) {
            query.andWhere('u.CreatedAt >= :fromDate', { fromDate: filters.fromDate });
        }
        if (filters?.toDate) {
            query.andWhere('u.CreatedAt <= :toDate', { toDate: filters.toDate });
        }

        // Role filter
        if (filters?.roleId) {
            query.leftJoinAndSelect('u.UserRoles', 'ur', 'ur.IsDeleted = :urDeleted AND ur.RoleId = :roleId', {
                urDeleted: false,
                roleId: filters.roleId
            })
            .andWhere('ur.UserRoleId IS NOT NULL');
        }

        // Organization filter
        if (filters?.organizationId) {
            if (!filters?.roleId) {
                query.leftJoinAndSelect('u.UserRoles', 'ur', 'ur.IsDeleted = :urDeleted', { urDeleted: false });
            }
            query.andWhere('ur.OrganizationId = :organizationId', { organizationId: filters.organizationId });
        }

        // Apply sorting
        const orderByColumn = sortBy === 'updatedAt' ? 'u.UpdatedAt' : sortBy === 'firstName' ? 'u.FirstName' : 'u.CreatedAt';
        query.orderBy(orderByColumn, sortOrder as 'ASC' | 'DESC');

        // Apply pagination
        query.skip(skip).take(pageSize);

        const [data, total] = await query.getManyAndCount();

        return {
            data,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize)
        };
    }
}

export const userRepository = new UserRepository();
