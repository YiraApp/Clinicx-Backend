import { v4 as uuidv4 } from "uuid";
import { AppDataSource } from "../../config/database.js";
import { AbhaProfileShare } from "../../models/Abdm/abha-profile-share.model.js";
import { User } from "../../models/Account/user.model.js";
import { Address } from "../../models/Account/address.model.js";
import { Role } from "../../models/Account/role.model.js";
import { UserRole } from "../../models/Account/userrole.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import type { AbhaShareStore, SharedPatient, ShareRow } from "../../services/Abdm/abha-share.service.js";

const PATIENT_ROLE_FALLBACK_ID = "4FC67429-28AE-4106-93EF-436228282ED0";
const CREATED_BY = "ABDM Scan and Share";

const toRow = (share: AbhaProfileShare): ShareRow => ({
    id: share.Id,
    requestId: share.RequestId,
    hipId: share.HipId,
    counterId: share.CounterId,
    abhaNumber: share.AbhaNumber ?? null,
    abhaAddress: share.AbhaAddress,
    patientName: share.PatientName ?? null,
    userId: share.UserId ?? null,
    hospitalId: share.HospitalId ?? null,
    tokenNumber: share.TokenNumber ?? null,
    expiresAt: share.ExpiresAt ?? null,
    status: share.Status as ShareRow["status"],
    matchType: (share.MatchType ?? null) as ShareRow["matchType"],
    error: share.Error ?? null,
    createdAt: share.CreatedAt,
});

const toColumns = (row: Partial<Omit<ShareRow, "id" | "createdAt">>): Partial<AbhaProfileShare> => {
    const columns: Partial<AbhaProfileShare> = {};
    if (row.requestId !== undefined) columns.RequestId = row.requestId;
    if (row.hipId !== undefined) columns.HipId = row.hipId;
    if (row.counterId !== undefined) columns.CounterId = row.counterId;
    if (row.abhaNumber !== undefined) columns.AbhaNumber = row.abhaNumber;
    if (row.abhaAddress !== undefined) columns.AbhaAddress = row.abhaAddress;
    if (row.patientName !== undefined) columns.PatientName = row.patientName;
    if (row.userId !== undefined) columns.UserId = row.userId;
    if (row.hospitalId !== undefined) columns.HospitalId = row.hospitalId;
    if (row.tokenNumber !== undefined) columns.TokenNumber = row.tokenNumber;
    if (row.expiresAt !== undefined) columns.ExpiresAt = row.expiresAt;
    if (row.status !== undefined) columns.Status = row.status;
    if (row.matchType !== undefined) columns.MatchType = row.matchType;
    if (row.error !== undefined) columns.Error = row.error;
    return columns;
};

/** Scan and Share's reads and writes: the share queue, and patients matched or created from a share. */
export class AbhaShareRepository implements AbhaShareStore {
    private get shares() {
        return AppDataSource.getRepository(AbhaProfileShare);
    }

    private get users() {
        return AppDataSource.getRepository(User);
    }

    async findShareByRequestId(requestId: string): Promise<ShareRow | null> {
        const share = await this.shares.findOne({ where: { RequestId: requestId } });
        return share ? toRow(share) : null;
    }

    async createShare(row: Omit<ShareRow, "id" | "createdAt">): Promise<number> {
        const saved = await this.shares.save(this.shares.create(toColumns(row)));
        return saved.Id;
    }

    async updateShare(id: number, changes: Partial<Omit<ShareRow, "id" | "createdAt">>): Promise<void> {
        await this.shares.update(id, { ...toColumns(changes), UpdatedAt: new Date() });
    }

    async findActiveShare(input: { userId: string; hospitalId: number; counterId: string; now: Date }): Promise<ShareRow | null> {
        const share = await this.shares.createQueryBuilder("s")
            .where("s.UserId = :userId AND s.HospitalId = :hospitalId AND s.CounterId = :counterId", input)
            .andWhere("s.ExpiresAt > :now AND s.TokenNumber IS NOT NULL", { now: input.now })
            .andWhere("s.Status IN (:...live)", { live: ["REGISTERED", "ACKNOWLEDGED"] })
            .orderBy("s.CreatedAt", "DESC")
            .getOne();
        return share ? toRow(share) : null;
    }

    async maxTokenToday(input: { hospitalId: number; counterId: string; since: Date }): Promise<number> {
        const row = await this.shares.createQueryBuilder("s")
            .select("MAX(TRY_CAST(s.TokenNumber AS INT))", "maxToken")
            .where("s.HospitalId = :hospitalId AND s.CounterId = :counterId AND s.CreatedAt >= :since", input)
            .getRawOne();
        return Number(row?.maxToken) || 0;
    }

    async listShares(input: { hospitalId: number; since: Date; counterId?: string }): Promise<ShareRow[]> {
        const query = this.shares.createQueryBuilder("s")
            .where("s.HospitalId = :hospitalId AND s.CreatedAt >= :since", input)
            .orderBy("s.CreatedAt", "DESC")
            .take(200);
        if (input.counterId) query.andWhere("s.CounterId = :counterId", { counterId: input.counterId });
        return (await query.getMany()).map(toRow);
    }

    async findPatientIdByAbhaNumber(abhaNumber: string): Promise<string | null> {
        const user = await this.users.findOne({ where: { AbhaNumber: abhaNumber, IsDeleted: false }, select: { Id: true } });
        return user?.Id ?? null;
    }

    async findPatientIdsByDemographics(patient: SharedPatient): Promise<string[]> {
        if (!patient.phone || !patient.gender) return [];
        const query = this.users.createQueryBuilder("u")
            .select("u.Id", "id")
            .where("u.IsDeleted = 0")
            .andWhere("RIGHT(REPLACE(u.PhoneNumber, ' ', ''), 10) = :phone", { phone: patient.phone })
            .andWhere("LOWER(LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName)))) = LOWER(:name)", { name: patient.name })
            .andWhere("LOWER(u.Gender) = LOWER(:gender)", { gender: patient.gender })
            .andWhere("(u.AbhaNumber IS NULL OR u.AbhaNumber = :abhaNumber)", { abhaNumber: patient.abhaNumber ?? "" });
        if (patient.yearOfBirth) {
            query.andWhere("(u.DateOfBirth IS NULL OR YEAR(u.DateOfBirth) = :year)", { year: Number(patient.yearOfBirth) });
        }
        return (await query.getRawMany()).map((row: any) => String(row.id));
    }

    async createPatient(patient: SharedPatient, hospitalId: number): Promise<string> {
        const organizationId = await this.organizationOf(hospitalId);
        const tokenNumber = await this.nextRegistrationToken(hospitalId);
        const roleId = await this.patientRoleId();
        const userId = uuidv4();

        await AppDataSource.transaction(async (manager) => {
            // A family shares a handset: a mobile that already has a primary patient makes this one a family member.
            const primary = patient.phone
                ? await manager.getRepository(User).createQueryBuilder("u")
                    .where("u.IsDeleted = 0 AND u.ParentUserId IS NULL AND RIGHT(REPLACE(u.PhoneNumber, ' ', ''), 10) = :phone", { phone: patient.phone })
                    .orderBy("u.CreatedAt", "ASC")
                    .getOne()
                : null;

            let addressId: number | undefined;
            const { line, district, state, pincode } = patient.address;
            if (line || district || state || pincode) {
                const address = await manager.getRepository(Address).save(manager.getRepository(Address).create({
                    AddressLine1: line ?? undefined,
                    City: district ?? undefined,
                    State: state ?? undefined,
                    Pincode: pincode ?? undefined,
                    Country: "India",
                }));
                addressId = address.Id;
            }

            const user = new User();
            user.Id = userId;
            user.FirstName = patient.firstName;
            user.LastName = patient.lastName;
            user.PhoneNumber = patient.phone ?? "";
            user.CountryCode = "91";
            user.Gender = patient.gender;
            user.DateOfBirth = patient.dateOfBirth;
            user.Status = true;
            user.IsDeleted = false;
            user.IsPrimary = !primary;
            user.Relation = primary ? "Other" : "Self";
            user.ParentUserId = primary?.Id ?? null;
            user.PermanentAddressId = addressId;
            user.TokenNumber = tokenNumber;
            user.AbhaNumber = patient.abhaNumber;
            user.AbhaAddress = patient.abhaAddress;
            user.AbhaLinkedAt = new Date();
            user.RegisteredViaAbha = true;
            user.CreatedBy = CREATED_BY;
            await manager.getRepository(User).save(user);

            await this.registerAt(manager, userId, roleId, organizationId, hospitalId, tokenNumber);
        });
        return userId;
    }

    async updatePatientAbha(userId: string, patient: SharedPatient, hospitalId: number): Promise<void> {
        const user = await this.users.findOne({ where: { Id: userId }, select: { Id: true, AbhaNumber: true, AbhaLinkedAt: true, TokenNumber: true } });
        if (!user) throw new Error("The matched patient record no longer exists.");

        // The same person sharing another of their addresses updates it; the ABHA number never changes here.
        await this.users.update(userId, {
            ...(user.AbhaNumber ? {} : { AbhaNumber: patient.abhaNumber }),
            AbhaAddress: patient.abhaAddress,
            AbhaLinkedAt: user.AbhaLinkedAt ?? new Date(),
            RegisteredViaAbha: true,
        });

        const organizationId = await this.organizationOf(hospitalId);
        const registrations = AppDataSource.getRepository(PatientRegistration);
        const registered = await registrations.count({ where: { UserId: userId, HospitalId: hospitalId, IsDeleted: false } });
        if (registered > 0) {
            await registrations.update({ UserId: userId, HospitalId: hospitalId, IsDeleted: false }, { RegisteredViaAbha: true });
        } else {
            const tokenNumber = user.TokenNumber || await this.nextRegistrationToken(hospitalId);
            const roleId = await this.patientRoleId();
            await AppDataSource.transaction((manager) => this.registerAt(manager, userId, roleId, organizationId, hospitalId, tokenNumber));
        }
    }

    /** The patient role and the patient registration at [hospitalId], as the booking flow creates them. */
    private async registerAt(manager: typeof AppDataSource.manager, userId: string, roleId: string, organizationId: number | null, hospitalId: number, tokenNumber: string): Promise<void> {
        const roles = manager.getRepository(UserRole);
        const existingRole = await roles.findOne({ where: { UserId: userId, RoleId: roleId, HospitalId: hospitalId, IsDeleted: false } });
        if (!existingRole) {
            const role = new UserRole();
            role.UserId = userId;
            role.RoleId = roleId;
            role.OrganizationId = organizationId ?? undefined;
            role.HospitalId = hospitalId;
            role.Status = true;
            role.IsDeleted = false;
            role.CreatedBy = CREATED_BY;
            await roles.save(role);
        }

        const registration = new PatientRegistration();
        registration.UserId = userId;
        registration.OrganizationId = organizationId ?? undefined;
        registration.HospitalId = hospitalId;
        registration.TokenNumber = tokenNumber;
        registration.RegisteredViaAbha = true;
        registration.Status = true;
        registration.IsDeleted = false;
        registration.CreatedBy = CREATED_BY;
        await manager.getRepository(PatientRegistration).save(registration);
    }

    private async organizationOf(hospitalId: number): Promise<number | null> {
        const hospital = await AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId }, select: { Id: true, OrganizationId: true } });
        if (!hospital) throw new Error(`Hospital ${hospitalId} (ABDM_HIP_HOSPITAL_ID) does not exist.`);
        return hospital.OrganizationId ?? null;
    }

    private async patientRoleId(): Promise<string> {
        const role = await AppDataSource.getRepository(Role).findOne({ where: { RoleName: "Patient" }, select: { Id: true } });
        return role?.Id ?? PATIENT_ROLE_FALLBACK_ID;
    }

    /** The clinic's own patient token number, from the same sequence as front-desk registration. */
    private async nextRegistrationToken(hospitalId: number): Promise<string> {
        const { patientRegistrationService } = await import("../../services/Organizations/patient-registration.service.js");
        return (await patientRegistrationService.getNextTokenNumber(hospitalId)).tokenNumber;
    }
}

export const abhaShareRepository = new AbhaShareRepository();
