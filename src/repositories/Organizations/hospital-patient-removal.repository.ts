import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { User } from "../../models/Account/user.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { PATIENT_ROLE_ID } from "../../utils/staff-access.js";
import type {
    HospitalPatientStore,
    PatientHospitalLinks,
    RemovalPlan,
    RemovedLink,
    RemovedPatientQuery,
    RemovedPatientRow,
} from "../../services/Organizations/hospital-patient-removal.service.js";

/** 2627 / 2601: a unique key or unique index refused a duplicate row. */
const isDuplicateKey = (error: any): boolean => [2627, 2601].includes(Number(error?.driverError?.number ?? error?.number));

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/**
 * The SQL behind HospitalPatientRemovalService. Times are stamped from JS Dates through TypeORM, as
 * the rest of the app writes them, so they read back right (a GETDATE() stamp would read 5h30 early).
 */
export class HospitalPatientRemovalRepository implements HospitalPatientStore {
    async isFrontDeskAt(userId: string, hospitalId: number): Promise<boolean> {
        const rows = await AppDataSource.query(
            `SELECT TOP 1 1 AS ok
             FROM UserRoles ur
             INNER JOIN Roles r ON r.Id = ur.RoleId
             WHERE ur.UserId = @0 AND ur.HospitalId = @1 AND ur.IsDeleted = 0 AND ur.Status = 1
               AND UPPER(LTRIM(RTRIM(r.RoleName))) = 'FRONT DESK'`,
            [userId, hospitalId]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    async hospitalOrganization(hospitalId: number): Promise<number | null | undefined> {
        const rows = await AppDataSource.query(`SELECT TOP 1 OrganizationId FROM Hospitals WHERE Id = @0 AND IsDeleted = 0`, [hospitalId]);
        if (!rows?.length) return undefined;
        const organizationId = rows[0].OrganizationId;
        return organizationId === null || organizationId === undefined ? null : Number(organizationId);
    }

    async patientLinks(userId: string, hospitalId: number, organizationId: number | null): Promise<PatientHospitalLinks | null> {
        const users = await AppDataSource.query(`SELECT TOP 1 Id FROM Users WHERE Id = @0 AND IsDeleted = 0`, [userId]);
        if (!users?.length) return null;

        const roles: { UserRoleId: number; HospitalId: number | null; Status: boolean }[] = await AppDataSource.query(
            `SELECT UserRoleId, HospitalId, Status
             FROM UserRoles
             WHERE UserId = @0 AND RoleId = @1 AND IsDeleted = 0
               AND (HospitalId = @2 OR (@3 IS NOT NULL AND OrganizationId = @3 AND HospitalId IS NOT NULL))`,
            [userId, PATIENT_ROLE_ID, hospitalId, organizationId]
        );
        const registrations: { Id: number; HospitalId: number | null }[] = await AppDataSource.query(
            `SELECT Id, HospitalId
             FROM PatientRegistrations
             WHERE UserId = @0 AND IsDeleted = 0 AND ((@1 IS NOT NULL AND OrganizationId = @1) OR HospitalId = @2)`,
            [userId, organizationId, hospitalId]
        );

        return {
            organizationId,
            roleIdsHere: roles.filter((r) => Number(r.HospitalId) === hospitalId).map((r) => Number(r.UserRoleId)),
            otherHospitalIds: [...new Set(roles
                .filter((r) => r.HospitalId !== null && Number(r.HospitalId) !== hospitalId && (r.Status === true || Number(r.Status) === 1))
                .map((r) => Number(r.HospitalId)))],
            registrations: registrations.map((r) => ({ id: Number(r.Id), hospitalId: r.HospitalId === null ? null : Number(r.HospitalId) })),
        };
    }

    async applyRemoval(plan: RemovalPlan, actorId: string, at: Date): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            const roles = manager.getRepository(UserRole);
            const registrations = manager.getRepository(PatientRegistration);
            if (plan.roleIds.length > 0) {
                await roles.update({ UserRoleId: In(plan.roleIds), IsDeleted: false }, { IsDeleted: true, UpdatedBy: actorId, UpdatedAt: at });
            }
            if (plan.deleteRegistrationIds.length > 0) {
                await registrations.update({ Id: In(plan.deleteRegistrationIds), IsDeleted: false }, { IsDeleted: true, UpdatedBy: actorId, UpdatedAt: at });
            }
            for (const move of plan.moveRegistrations) {
                await registrations.update({ Id: move.id, IsDeleted: false }, { HospitalId: move.hospitalId, UpdatedBy: actorId, UpdatedAt: at });
            }
        });
    }

    async latestRemoval(userId: string, hospitalId: number): Promise<RemovedLink | null> {
        const rows = await AppDataSource.query(
            `SELECT TOP 1 ur.UserRoleId, ur.UserId, ur.RoleId, ur.OrganizationId, ur.HospitalId, ur.UpdatedAt, ur.UpdatedBy
             FROM UserRoles ur
             INNER JOIN Users u ON u.Id = ur.UserId AND u.IsDeleted = 0
             WHERE ur.UserId = @0 AND ur.HospitalId = @1 AND ur.RoleId = @2 AND ur.IsDeleted = 1 AND ur.UpdatedBy IS NOT NULL
             ORDER BY ur.UpdatedAt DESC, ur.UserRoleId DESC`,
            [userId, hospitalId, PATIENT_ROLE_ID]
        );
        const row = rows?.[0];
        if (!row) return null;
        return {
            userRoleId: Number(row.UserRoleId),
            userId: String(row.UserId),
            roleId: String(row.RoleId),
            organizationId: row.OrganizationId === null ? null : Number(row.OrganizationId),
            hospitalId: Number(row.HospitalId),
            removedAt: row.UpdatedAt ?? null,
            removedBy: row.UpdatedBy ?? null,
        };
    }

    async restore(link: RemovedLink, actorId: string, at: Date): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            const roles = manager.getRepository(UserRole);
            try {
                // A new live row: the removed one stays as the record of who removed the patient and when.
                await roles.insert({
                    UserId: link.userId,
                    RoleId: link.roleId,
                    OrganizationId: link.organizationId ?? undefined,
                    HospitalId: link.hospitalId,
                    Status: true,
                    IsDeleted: false,
                    CreatedAt: at,
                    CreatedBy: actorId,
                });
            } catch (error) {
                if (!isDuplicateKey(error)) throw error;
                // The old unique key (UQ_UserRoles, deleted rows included) is still in place here:
                // bring the removed row itself back instead.
                await roles.update({ UserRoleId: link.userRoleId }, { IsDeleted: false, Status: true, UpdatedBy: actorId, UpdatedAt: at });
            }

            // Their registration (allergies, history, token) comes back with them, unless they have a live one.
            const registrations = manager.getRepository(PatientRegistration);
            const inOrganization = link.organizationId === null ? { OrganizationId: IsNull() } : { OrganizationId: link.organizationId };
            const live = await registrations.count({ where: { UserId: link.userId, IsDeleted: false, ...inOrganization } });
            if (live > 0) return;

            const removed = await registrations.findOne({
                where: { UserId: link.userId, IsDeleted: true, UpdatedBy: Not(IsNull()), ...inOrganization },
                order: { UpdatedAt: "DESC", Id: "DESC" },
            });
            if (removed) {
                await registrations.update({ Id: removed.Id }, { IsDeleted: false, Status: true, HospitalId: link.hospitalId, UpdatedBy: actorId, UpdatedAt: at });
                return;
            }

            const user = await manager.getRepository(User).findOne({ where: { Id: link.userId }, select: { Id: true, TokenNumber: true, EmployeeId: true } });
            await registrations.insert({
                UserId: link.userId,
                OrganizationId: link.organizationId ?? undefined,
                HospitalId: link.hospitalId,
                TokenNumber: user?.TokenNumber ?? undefined,
                EmployeeId: user?.EmployeeId ?? undefined,
                RegisteredViaAbha: false,
                Status: true,
                IsDeleted: false,
                CreatedAt: at,
                UpdatedAt: at,
                CreatedBy: actorId,
            });
        });
    }

    async listRemoved(query: RemovedPatientQuery): Promise<{ rows: RemovedPatientRow[]; total: number }> {
        const params: unknown[] = [query.hospitalId, PATIENT_ROLE_ID];
        let searchClause = "";
        if (query.search) {
            params.push(`%${query.search}%`);
            const s = `@${params.length - 1}`;
            searchClause = `AND (u.FirstName LIKE ${s} OR u.LastName LIKE ${s}
                OR (ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '')) LIKE ${s}
                OR u.PhoneNumber LIKE ${s} OR u.TokenNumber LIKE ${s} OR p.TokenNumber LIKE ${s})`;
        }
        params.push((query.page - 1) * query.pageSize, query.pageSize);
        const offset = `@${params.length - 2}`;
        const fetch = `@${params.length - 1}`;

        const rows = await AppDataSource.query(
            `WITH removed AS (
                SELECT ur.UserRoleId, ur.UserId, ur.OrganizationId, ur.UpdatedAt, ur.UpdatedBy,
                       ROW_NUMBER() OVER (PARTITION BY ur.UserId ORDER BY ur.UpdatedAt DESC, ur.UserRoleId DESC) AS rn
                FROM UserRoles ur
                WHERE ur.HospitalId = @0 AND ur.RoleId = @1 AND ur.IsDeleted = 1 AND ur.UpdatedBy IS NOT NULL
            )
            SELECT r.UserId, r.UpdatedAt AS RemovedAt, r.UpdatedBy AS RemovedById,
                   u.FirstName, u.LastName, u.Gender, u.DateOfBirth, u.PhoneNumber,
                   COALESCE(p.TokenNumber, u.TokenNumber) AS TokenNumber,
                   LTRIM(RTRIM(ISNULL(d.FirstName, '') + ' ' + ISNULL(d.LastName, ''))) AS RemovedByName,
                   COUNT(*) OVER () AS Total
            FROM removed r
            INNER JOIN Users u ON u.Id = r.UserId AND u.IsDeleted = 0
            LEFT JOIN Users d ON d.Id = TRY_CONVERT(uniqueidentifier, r.UpdatedBy)
            OUTER APPLY (
                SELECT TOP 1 pr.TokenNumber FROM PatientRegistrations pr
                WHERE pr.UserId = r.UserId AND (pr.OrganizationId = r.OrganizationId OR pr.HospitalId = @0)
                ORDER BY pr.UpdatedAt DESC, pr.Id DESC
            ) p
            WHERE r.rn = 1
              -- Back at the hospital since (restored, or registered again): no longer removed
              AND NOT EXISTS (SELECT 1 FROM UserRoles a WHERE a.UserId = r.UserId AND a.HospitalId = @0 AND a.RoleId = @1 AND a.IsDeleted = 0)
              ${searchClause}
            ORDER BY r.UpdatedAt DESC, r.UserRoleId DESC
            OFFSET ${offset} ROWS FETCH NEXT ${fetch} ROWS ONLY`,
            params
        );

        return {
            total: rows?.length ? Number(rows[0].Total) : 0,
            rows: (rows || []).map((row: any) => ({
                userId: String(row.UserId),
                firstName: textOrNull(row.FirstName),
                lastName: textOrNull(row.LastName),
                gender: textOrNull(row.Gender),
                dateOfBirth: row.DateOfBirth ?? null,
                phone: textOrNull(row.PhoneNumber),
                tokenNumber: textOrNull(row.TokenNumber),
                removedAt: row.RemovedAt ?? null,
                removedById: textOrNull(row.RemovedById),
                removedByName: textOrNull(row.RemovedByName),
            })),
        };
    }

    async abhaOf(userId: string): Promise<{ abhaNumber: string | null; abhaAddresses: string[] } | null> {
        const users = await AppDataSource.query(`SELECT TOP 1 AbhaNumber, AbhaAddress FROM Users WHERE Id = @0 AND IsDeleted = 0`, [userId]);
        const user = users?.[0];
        if (!user) return null;
        const extra: { AbhaAddress: string }[] = await AppDataSource.query(`SELECT AbhaAddress FROM UserAbhaAddresses WHERE UserId = @0`, [userId]);
        const abhaAddresses = [...new Set([user.AbhaAddress, ...extra.map((row) => row.AbhaAddress)].filter((a): a is string => !!textOrNull(a)))];
        return { abhaNumber: textOrNull(user.AbhaNumber), abhaAddresses };
    }

    async unlinkAbha(userId: string, actorId: string, at: Date): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            await manager.getRepository(User).update(
                { Id: userId },
                { AbhaNumber: null, AbhaAddress: null, AbhaLinkedAt: null, RegisteredViaAbha: false, UpdatedBy: actorId, UpdatedAt: at }
            );
            // The address table has no IsDeleted, and an address left here would still find this patient
            // (Scan and Share, M2 discovery) and block linking it to the right record (unique address).
            await manager.query(`DELETE FROM UserAbhaAddresses WHERE UserId = @0`, [userId]);
            // The "ABHA" badge and the "From ABHA" filter read this flag
            await manager.getRepository(PatientRegistration).update(
                { UserId: userId, IsDeleted: false },
                { RegisteredViaAbha: false, UpdatedBy: actorId, UpdatedAt: at }
            );
        });
    }
}

export const hospitalPatientRemovalRepository = new HospitalPatientRemovalRepository();
