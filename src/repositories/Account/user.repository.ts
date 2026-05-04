import { In } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import type { IUserRepository } from "../../interfaces/Repository/Account/IUserRepository.js";

/**
 * Repository implementation for User entity.
 */
export class UserRepository implements IUserRepository {
    private repo = AppDataSource.getRepository(User);

    async getOrgUserStats(organizationId: number, filters?: any): Promise<{ totalUsers: number, activeUsers: number, roleCounts: any[] }> {
        // Base query for counting
        const baseQuery = this.repo.createQueryBuilder('u')
            .innerJoin('u.UserRoles', 'ur', 'ur.IsDeleted = 0 AND ur.Status = 1')
            .where('ur.OrganizationId = :organizationId', { organizationId })
            .andWhere('u.IsDeleted = 0');

        // Apply filters if provided
        if (filters) {
            if (filters.hospitalId) {
                baseQuery.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });
            }
            if (filters.search) {
                baseQuery.andWhere(
                    '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                    { search: `%${filters.search}%` }
                );
            }
            if (filters.status !== undefined) {
                baseQuery.andWhere('u.Status = :status', { status: filters.status });
            }
            if (filters.roleId) {
                baseQuery.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
            }
        }

        // Count total users (filtered)
        const totalUsersResult = await baseQuery.clone()
            .select('COUNT(DISTINCT u.Id)', 'count')
            .getRawOne();

        // Count active users (filtered + active status)
        const activeUsersResult = await baseQuery.clone()
            .andWhere('u.Status = 1')
            .select('COUNT(DISTINCT u.Id)', 'count')
            .getRawOne();

        // Role counts (filtered)
        const roleCountsRaw = await this.repo.createQueryBuilder('u')
            .innerJoin('u.UserRoles', 'ur', 'ur.IsDeleted = 0 AND ur.Status = 1')
            .innerJoin('ur.Role', 'r')
            .where('ur.OrganizationId = :organizationId', { organizationId })
            .andWhere('u.IsDeleted = 0')
            .andWhere('r.RoleName != \'Yira System Admin\'');

        // Apply same filters to role counts
        if (filters) {
            if (filters.hospitalId) roleCountsRaw.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });
            if (filters.search) {
                roleCountsRaw.andWhere(
                    '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                    { search: `%${filters.search}%` }
                );
            }
            if (filters.status !== undefined) roleCountsRaw.andWhere('u.Status = :status', { status: filters.status });
            if (filters.roleId) roleCountsRaw.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
        }

        const roleCounts = await roleCountsRaw
            .select('r.Id', 'RoleId')
            .addSelect('r.RoleName', 'RoleName')
            .addSelect('COUNT(DISTINCT u.Id)', 'userCount')
            .groupBy('r.Id')
            .addGroupBy('r.RoleName')
            .getRawMany();

        return {
            totalUsers: parseInt(totalUsersResult.count || '0'),
            activeUsers: parseInt(activeUsersResult.count || '0'),
            roleCounts: roleCounts.map((rc: any) => ({
                RoleId: rc.RoleId,
                RoleName: rc.RoleName,
                userCount: parseInt(rc.userCount || '0')
            }))
        };
    }

    async getOrgUsers(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        const organizationId = filters.organizationId;
        if (!organizationId) {
            throw new Error("Organization ID is required for getOrgUsers");
        }

        const skip = (page - 1) * pageSize;
        const sortBy = filters?.sortBy || 'CreatedAt';
        const sortOrder = filters?.sortOrder || 'DESC';

        const query = this.repo.createQueryBuilder('u')
            .innerJoinAndSelect('u.UserRoles', 'ur', 'ur.IsDeleted = 0 AND ur.Status = 1 AND ur.OrganizationId = :organizationId', { organizationId })
            .leftJoinAndSelect('ur.Role', 'r')
            .leftJoinAndSelect('ur.Organization', 'org')
            .leftJoinAndSelect('ur.Hospital', 'h')
            .where('u.IsDeleted = 0');

        if (filters.hospitalId) {
            query.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });
        }

        if (filters.search) {
            query.andWhere(
                '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                { search: `%${filters.search}%` }
            );
        }

        if (filters.status !== undefined) {
            query.andWhere('u.Status = :status', { status: filters.status });
        }

        if (filters.roleId) {
            query.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
        }

        if (filters.gender) {
            query.andWhere('u.Gender = :gender', { gender: filters.gender });
        }


        const orderByColumn = sortBy === 'updatedAt' ? 'u.UpdatedAt' : sortBy === 'firstName' ? 'u.FirstName' : 'u.CreatedAt';
        query.orderBy(orderByColumn, sortOrder as 'ASC' | 'DESC');

        const [users, total] = await query.skip(skip).take(pageSize).getManyAndCount();

        // Stats specifically for this org with filters applied
        const stats = await this.getOrgUserStats(organizationId, filters);

        // Transformation logic (similar to getUsers but filtered for this org)
        const transformedData = users.map(u => {
            const rolesMap = new Map<string, any>();

            u.UserRoles?.forEach(ur => {
                if (!ur.Role || ur.OrganizationId !== organizationId) return;

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
                            UserRoleId: ur.HospitalId ? null : ur.UserRoleId,
                            OrganizationId: ur.Organization.Id,
                            OrganizationName: ur.Organization.Name,
                            OrganizationCode: ur.Organization.OrgCode,
                            OrgCode: ur.Organization.OrgCode,
                            Hospitals: []
                        });
                    }

                    if (ur.Hospital) {
                        const orgNode = roleNode.Organizations.get(ur.Organization.Id);
                        if (!orgNode.Hospitals.some((h: any) => h.HospitalId === ur.Hospital?.Id)) {
                            orgNode.Hospitals.push({
                                UserRoleId: ur.UserRoleId,
                                HospitalId: ur.Hospital.Id,
                                HospitalName: ur.Hospital.Name,
                                HospitalCode: ur.Hospital.HospitalCode
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
                status: u.Status ? "Active" : "Inactive",
                isActive: u.Status,
                isParentOrgUser: u.IsPrimary,
                lastLogin: u.LastLoginTime,
                createdAt: u.CreatedAt,
                roles: Array.from(rolesMap.values()).map(r => ({
                    RoleId: r.RoleId,
                    RoleName: r.RoleName,
                    Organizations: Array.from(r.Organizations.values())
                }))
            };
        });

        return {
            summary: {
                totalUsers: stats.totalUsers,
                activeUsers: stats.activeUsers,
                roleCounts: stats.roleCounts
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

    async getHospUsers(page: number = 1, pageSize: number = 10, filters: any): Promise<any> {
        if (!filters.hospitalId) {
            throw new Error("Hospital ID is required for getHospUsers");
        }
        // getOrgUsers already handles hospitalId filtering if passed in filters
        return await this.getOrgUsers(page, pageSize, filters);
    }

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

    async checkUserRole(identifier: string, roleId: string, organizationId?: number, hospitalId?: number): Promise<boolean> {
        console.log("[UserRepository] checkUserRole input:", { identifier, roleId, organizationId, hospitalId });

        const query = this.repo.createQueryBuilder('u')
            .innerJoin('u.UserRoles', 'ur', 'ur.IsDeleted = 0 AND ur.Status = 1')
            .where('(u.PhoneNumber = :identifier OR u.Email = :identifier)', { identifier })
            .andWhere('ur.RoleId = :roleId', { roleId })
            .andWhere('u.IsDeleted = 0');

        if (organizationId) {
            query.andWhere('ur.OrganizationId = :organizationId', { organizationId });
        }
        if (hospitalId) {
            query.andWhere('ur.HospitalId = :hospitalId', { hospitalId });
        }

        const userWithRole = await query.getOne();
        console.log("[UserRepository] checkUserRole result:", userWithRole ? `Found User ID: ${userWithRole.Id}` : "Not Found");

        return !!userWithRole;
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

    async updateUser(id: string, data: Partial<User>): Promise<void> {
        await this.repo.update(id, { ...data, UpdatedAt: new Date() });
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

        // 3. Summaries (Filter-aware)
        const summaryCountQuery = this.repo.createQueryBuilder('u')
            .leftJoin('u.UserRoles', 'ur', 'ur.IsDeleted = :urDeleted AND ur.Status = :urStatus', { urDeleted: false, urStatus: true })
            .where('u.IsDeleted = :isDeleted', { isDeleted: false });

        if (filters?.search) {
            summaryCountQuery.andWhere(
                '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                { search: `%${filters.search}%` }
            );
        }
        if (filters?.status !== undefined) summaryCountQuery.andWhere('u.Status = :status', { status: filters.status });
        if (filters?.roleId) summaryCountQuery.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
        if (filters?.organizationId) summaryCountQuery.andWhere('ur.OrganizationId = :organizationId', { organizationId: filters.organizationId });
        if (filters?.hospitalId) summaryCountQuery.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });

        const totalUsersFiltered = await summaryCountQuery.clone().select('COUNT(DISTINCT u.Id)', 'count').getRawOne();
        const activeUsersFiltered = await summaryCountQuery.clone().andWhere('u.Status = 1').select('COUNT(DISTINCT u.Id)', 'count').getRawOne();

        // Role Counts (Filter-aware)
        const roleSummaryQuery = this.repo.createQueryBuilder('u')
            .innerJoin('u.UserRoles', 'ur', 'ur.IsDeleted = 0 AND ur.Status = 1')
            .innerJoin('ur.Role', 'r')
            .where('u.IsDeleted = 0');

        if (filters?.search) {
            roleSummaryQuery.andWhere(
                '(u.FirstName LIKE :search OR u.LastName LIKE :search OR u.Email LIKE :search OR u.PhoneNumber LIKE :search)',
                { search: `%${filters.search}%` }
            );
        }
        if (filters?.status !== undefined) roleSummaryQuery.andWhere('u.Status = :status', { status: filters.status });
        if (filters?.roleId) roleSummaryQuery.andWhere('ur.RoleId = :roleId', { roleId: filters.roleId });
        if (filters?.organizationId) roleSummaryQuery.andWhere('ur.OrganizationId = :organizationId', { organizationId: filters.organizationId });
        if (filters?.hospitalId) roleSummaryQuery.andWhere('ur.HospitalId = :hospitalId', { hospitalId: filters.hospitalId });

        const roleCountsRaw = await roleSummaryQuery
            .select('r.Id', 'RoleId')
            .addSelect('r.RoleName', 'RoleName')
            .addSelect('COUNT(DISTINCT u.Id)', 'userCount')
            .groupBy('r.Id')
            .addGroupBy('r.RoleName')
            .getRawMany();

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
                totalUsers: parseInt(totalUsersFiltered.count || '0'),
                activeUsers: parseInt(activeUsersFiltered.count || '0'),
                healthcareProviders: healthcareCount,
                organizations: parseInt(orgCount[0].count),
                roleCounts: roleCountsRaw.map((rc: any) => ({
                    RoleId: rc.RoleId,
                    RoleName: rc.RoleName,
                    userCount: parseInt(rc.userCount || '0')
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
