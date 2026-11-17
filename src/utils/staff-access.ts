import { AppDataSource } from "../config/database.js";
import { UserRole } from "../models/Account/userrole.model.js";
import { HealthcareProvider } from "../models/Organizations/healthcare-provider.model.js";
import { Hospital } from "../models/Organizations/hospital.model.js";

export const PATIENT_ROLE_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
/** The role name the web sidebar and API logging use for Yira's own administrators */
export const YIRA_SYSTEM_ADMIN_ROLE_NAME = "Yira System Admin";

/** True when the user holds the active "Yira System Admin" role. */
export async function isYiraSystemAdmin(userId?: string | null): Promise<boolean> {
    if (!userId) return false;
    const count = await AppDataSource.getRepository(UserRole).createQueryBuilder("ur")
        .innerJoin("ur.Role", "r")
        .where("ur.UserId = :userId", { userId })
        .andWhere("ur.IsDeleted = 0 AND ur.Status = 1")
        .andWhere("LOWER(r.RoleName) = LOWER(:roleName)", { roleName: YIRA_SYSTEM_ADMIN_ROLE_NAME })
        .getCount();
    return count > 0;
}

/**
 * The hospitals a user works at: a doctor profile there, or an active non-patient role at the
 * hospital, or at its organisation when the role names no hospital (an organisation admin).
 */
export async function staffHospitalIds(userId?: string | null): Promise<number[]> {
    if (!userId) return [];
    const ids = new Set<number>();

    const providers = await AppDataSource.getRepository(HealthcareProvider).find({
        where: { UserId: userId, IsDeleted: false },
        select: { HospitalId: true }
    });
    providers.forEach(p => p.HospitalId && ids.add(Number(p.HospitalId)));

    const roles = await AppDataSource.getRepository(UserRole).createQueryBuilder("ur")
        .where("ur.UserId = :userId", { userId })
        .andWhere("ur.IsDeleted = 0 AND ur.Status = 1")
        .andWhere("UPPER(CAST(ur.RoleId AS NVARCHAR(36))) <> :patientRoleId", { patientRoleId: PATIENT_ROLE_ID })
        .getMany();
    roles.forEach(r => r.HospitalId && ids.add(Number(r.HospitalId)));

    const orgIds = roles.filter(r => !r.HospitalId && r.OrganizationId).map(r => Number(r.OrganizationId));
    if (orgIds.length > 0) {
        const hospitals = await AppDataSource.getRepository(Hospital).createQueryBuilder("h")
            .select("h.Id", "Id")
            .where("h.OrganizationId IN (:...orgIds)", { orgIds })
            .getRawMany();
        hospitals.forEach(h => ids.add(Number(h.Id)));
    }
    return Array.from(ids);
}

/** True when the user may manage the hospital's records: Yira System Admin, or staff of that hospital. */
export async function canManageHospital(userId: string | null | undefined, hospitalId: number): Promise<boolean> {
    if (!userId || !hospitalId) return false;
    if (await isYiraSystemAdmin(userId)) return true;
    return (await staffHospitalIds(userId)).includes(Number(hospitalId));
}
