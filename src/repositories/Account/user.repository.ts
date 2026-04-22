import { In } from "typeorm";
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

    async deleteById(id: string): Promise<boolean> {
        const user = await this.findById(id);
        if (user) {
            user.IsDeleted = true;
            user.UpdatedAt = new Date();
            await this.repo.save(user);
            return true;
        }
        return false;
    }

    async updateStatus(id: string, status: boolean): Promise<void> {
        await this.repo.update(id, { Status: status, UpdatedAt: new Date() });
    }

    async getUsers(page: number = 1, pageSize: number = 10, filters?: any): Promise<any> {
        const skip = (page - 1) * pageSize;
        const sortBy = filters?.sortBy || 'CreatedAt';
        const sortOrder = filters?.sortOrder || 'DESC';

        // 1. Base query for users
        const query = this.repo.createQueryBuilder('u')
            .leftJoinAndSelect('u.UserRoles', 'ur', 'ur.IsDeleted = :urDeleted AND ur.Status = :urStatus', { urDeleted: false, urStatus: true })
            .leftJoinAndSelect('ur.Role', 'r')
            .leftJoinAndSelect('ur.Organization', 'org')
            .leftJoinAndSelect('ur.Hospital', 'h')
            .where('u.IsDeleted = :isDeleted', { isDeleted: false });

        // Apply Filters
        if (filters?.search) {
            query.andWhere(
                '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                { search: `%${filters.search}%` }
            );
        }

        if (filters?.status !== undefined) {
            query.andWhere('u.Status = :status', { status: filters.status });
        }

        if (filters?.roleId) {
            query.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
        }

        if (filters?.organizationId) {
            query.andWhere('ur.OrganizationId = :organizationId', { organizationId: filters.organizationId });
        }

        if (filters?.hospitalId) {
            query.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });
        }

        // 2. Fetch paginated data
        const orderByColumn = sortBy === 'updatedAt' ? 'u.UpdatedAt' : sortBy === 'firstName' ? 'u.FirstName' : 'u.CreatedAt';
        query.orderBy(orderByColumn, sortOrder as 'ASC' | 'DESC');

        const [users, total] = await query.skip(skip).take(pageSize).getManyAndCount();

        // Manual lookup for Parent accounts to avoid model relationship requirements
        const parentIds = Array.from(new Set(users.map(u => u.ParentUserId).filter(id => !!id))) as string[];
        const parentMap = new Map<string, any>();
        if (parentIds.length > 0) {
            const parents = await this.repo.find({
                where: { Id: In(parentIds) }
            });
            parents.forEach(p => {
                parentMap.set(p.Id, {
                    id: p.Id,
                    name: `${p.FirstName || ""} ${p.LastName || ""}`.trim(),
                    phone: p.PhoneNumber,
                    email: p.Email
                });
            });
        }

        // 3. Summaries (Global status or filter-aware depending on preference - here following filter context)
        const activeUsersCount = await this.repo.count({ where: { Status: true, IsDeleted: false } });
        
        // Dynamic Role Counts Aggregation
        const roleCountsRaw = await AppDataSource.query(`
            SELECT r.Id as RoleId, r.RoleName, COUNT(DISTINCT ur.UserId) as userCount
            FROM Roles r
            LEFT JOIN UserRoles ur ON r.Id = ur.RoleId AND ur.IsDeleted = 0 AND ur.Status = 1
            GROUP BY r.Id, r.RoleName
        `);

        const orgCount = await AppDataSource.query(`SELECT COUNT(*) as count FROM Organizations`);

        // 4. Transform Data to Nested Structure: Roles -> Organizations -> Hospitals
        const transformedData = users.map(u => {
            const rolesMap = new Map<string, any>();

            u.UserRoles?.forEach(ur => {
                if (!ur.Role) return;

                if (!rolesMap.has(ur.Role.Id)) {
                    rolesMap.set(ur.Role.Id, {
                        RoleId: ur.Role.Id,
                        RoleName: ur.Role.RoleName,
                        Organizations: new Map<number, any>()
                    });
                }

                const roleNode = rolesMap.get(ur.Role.Id);

                if (ur.Organization) {
                    if (!roleNode.Organizations.has(ur.Organization.Id)) {
                        roleNode.Organizations.set(ur.Organization.Id, {
                            UserRoleId: ur.HospitalId ? null : ur.UserRoleId, // Only set here if it's an Org-wide role
                            OrganizationId: ur.Organization.Id,
                            OrganizationName: ur.Organization.Name,
                            Hospitals: []
                        });
                    }

                    if (ur.Hospital) {
                        const orgNode = roleNode.Organizations.get(ur.Organization.Id);
                        // Prevent duplicate hospital entries within the same org
                        if (!orgNode.Hospitals.some((h: any) => h.HospitalId === ur.Hospital?.Id)) {
                            orgNode.Hospitals.push({
                                UserRoleId: ur.UserRoleId,
                                HospitalId: ur.Hospital.Id,
                                HospitalName: ur.Hospital.Name
                            });
                        }
                    }
                }
            });

            return {
                id: u.Id,
                firstName: u.FirstName,
                lastName: u.LastName,
                name: `${u.FirstName || ""} ${u.LastName || ""}`.trim(),
                fullName: `${u.FirstName || ""} ${u.LastName || ""}`.trim(),
                email: u.Email,
                phone: u.PhoneNumber,
                countryCode: u.CountryCode || "91",
                gender: u.Gender,
                dateOfBirth: u.DateOfBirth,
                bloodGroup: u.BloodGroup,
                aadharNo: u.AadharNo,
                alternatePhoneNumber: u.AlternatePhoneNumber,
                isMobileVerified: u.IsMobileVerified,
                isEmailVerified: u.IsEmailVerified,
                status: u.Status ? "Active" : "Inactive",
                isActive: u.Status,
                isParentOrgUser: u.IsPrimary,
                parentUserId: u.ParentUserId,
                parentAccount: u.ParentUserId ? parentMap.get(u.ParentUserId) : null,
                relation: u.Relation,
                height: u.Height,
                weight: u.Weight,
                imagePath: u.ImagePath,
                lastLogin: u.LastLoginTime,
                createdAt: u.CreatedAt,
                roles: Array.from(rolesMap.values()).map(r => ({
                    RoleId: r.RoleId,
                    RoleName: r.RoleName,
                    Organizations: Array.from(r.Organizations.values())
                }))
            };
        });

        const healthcareCount = roleCountsRaw
            .filter((rc: any) => rc.RoleName.toLowerCase().includes('doctor') || rc.RoleName.toLowerCase().includes('nurse'))
            .reduce((sum: number, rc: any) => sum + parseInt(rc.userCount), 0);

        return {
            summary: {
                totalUsers: total,
                activeUsers: activeUsersCount,
                healthcareProviders: healthcareCount,
                organizations: parseInt(orgCount[0].count),
                roleCounts: roleCountsRaw.map((rc: any) => ({
                    RoleId: rc.RoleId,
                    RoleName: rc.RoleName,
                    userCount: parseInt(rc.userCount)
                }))
            },
            data: {
                data: transformedData,
                total: total,
                page: page,
                pageSize: pageSize,
                totalPages: Math.ceil(total / pageSize)
            }
        };
    }
}

export const userRepository = new UserRepository();
