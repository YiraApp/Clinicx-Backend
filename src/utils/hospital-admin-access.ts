import { AppDataSource } from "../config/database.js";

/** Hospital admins of this hospital, admins of its organization, and system admins. */
export async function canManageHospital(userId: string, hospitalId: number): Promise<boolean> {
    if (!userId || !Number.isInteger(hospitalId) || hospitalId <= 0) return false;
    const rows = await AppDataSource.query(
        `SELECT TOP 1 1 AS ok
         FROM UserRoles ur
         JOIN Roles r ON r.Id = ur.RoleId
         LEFT JOIN Hospitals h ON h.Id = @1
         WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND r.RoleName LIKE '%Admin%'
           AND (r.RoleName LIKE '%System%' OR ur.HospitalId = @1
                OR (r.RoleName LIKE '%Org%' AND ur.OrganizationId = h.OrganizationId))`,
        [userId, hospitalId]
    );
    return rows.length > 0;
}

/**
 * Anyone who works at this hospital: front desk, doctors, nurses and other staff roles
 * (any role there that isn't Patient), doctors registered as its providers, and its admins.
 */
export async function isHospitalStaff(userId: string, hospitalId: number): Promise<boolean> {
    if (!userId || !Number.isInteger(hospitalId) || hospitalId <= 0) return false;
    const rows = await AppDataSource.query(
        `SELECT TOP 1 1 AS ok FROM UserRoles ur JOIN Roles r ON r.Id = ur.RoleId
         WHERE ur.UserId = @0 AND ur.HospitalId = @1 AND ur.IsDeleted = 0
           AND ISNULL(ur.Status, 1) = 1 AND r.RoleName NOT LIKE '%Patient%'
         UNION ALL
         SELECT TOP 1 1 FROM HealthcareProviders hp WHERE hp.UserId = @0 AND hp.HospitalId = @1 AND ISNULL(hp.IsDeleted, 0) = 0`,
        [userId, hospitalId]
    );
    return rows.length > 0 || (await canManageHospital(userId, hospitalId));
}

/** System admins only. */
export async function isSystemAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;
    const rows = await AppDataSource.query(
        `SELECT TOP 1 1 AS ok FROM UserRoles ur JOIN Roles r ON r.Id = ur.RoleId
         WHERE ur.UserId = @0 AND ur.IsDeleted = 0 AND r.RoleName LIKE '%System%' AND r.RoleName LIKE '%Admin%'`,
        [userId]
    );
    return rows.length > 0;
}
