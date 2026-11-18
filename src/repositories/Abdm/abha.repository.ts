import { In } from "typeorm";
import { AppDataSource } from "../../config/database.js";
import { AbhaConsent } from "../../models/Abdm/abha-consent.model.js";
import { User } from "../../models/Account/user.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import type { HipHospitalLookup } from "../../services/Abdm/abdm-bridge.service.js";
import type { AbhaEnrolmentStore, AbhaToLink, LinkedPatient, NewAbhaConsent } from "../../services/Abdm/abha-enrolment.service.js";
import type { PatientCandidateQuery, PatientCandidateRow } from "../../services/Abdm/abha-patient-match.js";
import { PATIENT_ROLE_ID } from "../../utils/staff-access.js";

/** Digits only of a stored phone, in SQL: spaces, dashes, dots, brackets and the + go. */
const PHONE_DIGITS = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber, ' ', ''), '-', ''), '+', ''), '.', ''), '(', ''), ')', '')";

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const bit = (value: unknown): boolean => value === true || value === 1 || value === "1";

/** The ABHA journey's reads and writes in the clinic database: consents, ABHA on the Users row, and staff roles. */
export class AbhaRepository implements AbhaEnrolmentStore, HipHospitalLookup {
    private get consents() {
        return AppDataSource.getRepository(AbhaConsent);
    }

    private get users() {
        return AppDataSource.getRepository(User);
    }

    async findHospitalName(hospitalId: number): Promise<string | null> {
        const hospital = await AppDataSource.getRepository(Hospital).findOne({ where: { Id: hospitalId }, select: { Id: true, Name: true } });
        return hospital?.Name ?? null;
    }

    async saveConsent(consent: NewAbhaConsent): Promise<number> {
        const saved = await this.consents.save(this.consents.create({
            ConsentCode: consent.consentCode,
            ConsentVersion: consent.consentVersion,
            Declarations: consent.declarations,
            StaffUserId: consent.staffUserId,
            StaffName: consent.staffName,
            BeneficiaryName: consent.beneficiaryName,
            HospitalId: consent.hospitalId,
            OrganizationId: consent.organizationId,
            AgreedAt: consent.agreedAt,
        }));
        return saved.Id;
    }

    async updateConsent(consentId: number, changes: { txnId?: string; abhaNumber?: string; patientUserId?: string }): Promise<void> {
        const update: Partial<AbhaConsent> = {};
        if (changes.txnId !== undefined) update.TxnId = changes.txnId;
        if (changes.abhaNumber !== undefined) update.AbhaNumber = changes.abhaNumber;
        if (changes.patientUserId !== undefined) update.PatientUserId = changes.patientUserId;
        if (Object.keys(update).length > 0) {
            await this.consents.update(consentId, update);
        }
    }

    async staffName(userId: string): Promise<string | null> {
        const user = await this.users.findOne({ where: { Id: userId }, select: { Id: true, FirstName: true, LastName: true } });
        const name = `${user?.FirstName || ""} ${user?.LastName || ""}`.trim();
        return name || null;
    }

    /** Whether the user holds an active, non-Patient role at the hospital: who may read its Scan and Share queue. */
    async staffWorksAt(userId: string, hospitalId: number): Promise<boolean> {
        const rows = await AppDataSource.query(
            `SELECT TOP 1 1 AS WorksHere
             FROM UserRoles ur
             INNER JOIN Roles r ON r.Id = ur.RoleId
             WHERE ur.UserId = @0 AND ur.HospitalId = @1 AND ur.IsDeleted = 0 AND ur.Status = 1 AND r.RoleName <> 'Patient'`,
            [userId, hospitalId]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    /** The live user holding this ABHA number, saved dashed (91-1234-5678-9012) or as 14 bare digits. */
    async findPatientByAbhaNumber(abhaNumber: string): Promise<LinkedPatient | null> {
        const digits = abhaNumber.replace(/\D/g, "");
        const dashed = digits.length === 14 ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}` : null;
        const forms = [...new Set([abhaNumber.trim(), digits, dashed].filter((form): form is string => !!form))];
        const user = await this.users.findOne({
            where: { AbhaNumber: In(forms), IsDeleted: false },
            select: { Id: true, FirstName: true, LastName: true, TokenNumber: true },
        });
        if (!user) return null;
        return {
            userId: user.Id,
            name: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
            tokenNumber: user.TokenNumber ?? null,
        };
    }

    async findPatientByAbhaAddresses(abhaAddresses: string[]): Promise<LinkedPatient | null> {
        if (abhaAddresses.length === 0) return null;
        const list = abhaAddresses.map((_, i) => `@${i}`).join(", ");
        const rows = await AppDataSource.query(
            `SELECT TOP 1 u.Id, u.FirstName, u.LastName, u.TokenNumber
             FROM Users u
             WHERE u.IsDeleted = 0
               AND (LOWER(u.AbhaAddress) IN (${list})
                    OR EXISTS (SELECT 1 FROM UserAbhaAddresses a WHERE a.UserId = u.Id AND a.AbhaAddress IN (${list})))`,
            abhaAddresses.map((address) => address.toLowerCase()),
        );
        const user = rows[0];
        if (!user) return null;
        return {
            userId: String(user.Id),
            name: `${user.FirstName || ""} ${user.LastName || ""}`.trim(),
            tokenNumber: user.TokenNumber ?? null,
        };
    }

    async getPatient(userId: string): Promise<{ abhaNumber: string | null; abhaAddresses: string[]; isPatient: boolean } | null> {
        const user = await this.users.findOne({ where: { Id: userId, IsDeleted: false }, select: { Id: true, AbhaNumber: true, AbhaAddress: true } });
        if (!user) return null;
        const registrations = await AppDataSource.getRepository(PatientRegistration).count({ where: { UserId: userId, IsDeleted: false } });
        const rows: { AbhaAddress: string }[] = await AppDataSource.query(`SELECT AbhaAddress FROM UserAbhaAddresses WHERE UserId = @0`, [userId]);
        const abhaAddresses = [...new Set([user.AbhaAddress, ...rows.map((row) => row.AbhaAddress)]
            .filter((address): address is string => !!address)
            .map((address) => address.toLowerCase()))];
        return { abhaNumber: user.AbhaNumber ?? null, abhaAddresses, isPatient: registrations > 0 };
    }

    /**
     * Live, active patients (a registration anywhere) holding no ABHA number or address, born on
     * the date, of the gender or of none recorded, with their family's primary record. Registered
     * here: a registration or an active Patient role at the hospital, else at the organization.
     * At most [query.limit] rows: those whose phone ends in the mobile's last 4 digits, then those
     * holding a word of the name, come first, so a common date of birth does not crowd them out.
     */
    async findPatientCandidates(query: PatientCandidateQuery): Promise<PatientCandidateRow[]> {
        const params: unknown[] = [query.dateOfBirth, PATIENT_ROLE_ID];
        const param = (value: unknown): string => {
            params.push(value);
            return `@${params.length - 1}`;
        };
        // As the registration form compares genders: O stands for a stored Other or Transgender too.
        const letters = query.gender === "O" ? ["O", "T"] : query.gender ? [query.gender] : [];
        const gender = letters.length
            ? `AND (u.Gender IS NULL OR LTRIM(RTRIM(u.Gender)) = '' OR UPPER(LEFT(LTRIM(u.Gender), 1)) IN (${letters.map(param).join(", ")}))`
            : "";
        const limit = Math.max(1, Math.min(1000, Math.floor(query.limit)));
        const sameMobile = query.mobileLast4 && /^\d{4}$/.test(query.mobileLast4)
            ? `CASE WHEN RIGHT(${PHONE_DIGITS}, 4) = ${param(query.mobileLast4)} THEN 0 ELSE 1 END,`
            : "";
        // Name words are letters only (abha-patient-match words()), so they carry no LIKE wildcards.
        const nameWords = query.nameWords.filter((word) => /^[a-z]{2,}$/.test(word)).slice(0, 6);
        const sharesNameWord = nameWords.length
            ? `CASE WHEN ${nameWords.map((word) => `LOWER(CONCAT(u.FirstName, ' ', u.LastName)) LIKE ${param(`%${word}%`)}`).join(" OR ")} THEN 0 ELSE 1 END,`
            : "";
        const scope = query.hospitalId
            ? { column: "HospitalId", value: param(query.hospitalId) }
            : query.organizationId
                ? { column: "OrganizationId", value: param(query.organizationId) }
                : null;
        const registeredHere = scope
            ? `CASE WHEN EXISTS (SELECT 1 FROM PatientRegistrations r WHERE r.UserId = u.Id AND r.IsDeleted = 0 AND r.${scope.column} = ${scope.value})
                     OR EXISTS (SELECT 1 FROM UserRoles ur WHERE ur.UserId = u.Id AND ur.IsDeleted = 0 AND ur.Status = 1 AND ur.RoleId = @1 AND ur.${scope.column} = ${scope.value})
                    THEN 1 ELSE 0 END`
            : "0";
        const token = scope
            ? `(SELECT TOP 1 r.TokenNumber FROM PatientRegistrations r WHERE r.UserId = u.Id AND r.IsDeleted = 0 AND r.${scope.column} = ${scope.value} ORDER BY r.Id DESC)`
            : "NULL";
        const rows: Record<string, unknown>[] = await AppDataSource.query(
            `SELECT TOP ${limit}
                    u.Id, u.FirstName, u.LastName, CONVERT(varchar(10), u.DateOfBirth, 23) AS DateOfBirth, u.Gender,
                    u.PhoneNumber, u.Email, u.Relation, u.IsPrimary, u.BloodGroup,
                    COALESCE(${token}, u.TokenNumber) AS TokenNumber,
                    ${registeredHere} AS RegisteredHere,
                    p.Id AS PrimaryId, p.FirstName AS PrimaryFirstName, p.LastName AS PrimaryLastName,
                    CONVERT(varchar(10), p.DateOfBirth, 23) AS PrimaryDateOfBirth, p.Gender AS PrimaryGender,
                    p.PhoneNumber AS PrimaryPhone, p.Email AS PrimaryEmail, p.Relation AS PrimaryRelation
             FROM Users u
             LEFT JOIN Users p ON p.Id = u.ParentUserId AND p.IsDeleted = 0
             WHERE u.IsDeleted = 0 AND u.Status = 1
               AND u.DateOfBirth = @0
               ${gender}
               AND u.AbhaNumber IS NULL
               AND (u.AbhaAddress IS NULL OR LTRIM(RTRIM(u.AbhaAddress)) = '')
               AND NOT EXISTS (SELECT 1 FROM UserAbhaAddresses a WHERE a.UserId = u.Id)
               AND EXISTS (SELECT 1 FROM PatientRegistrations r WHERE r.UserId = u.Id AND r.IsDeleted = 0)
             ORDER BY ${sameMobile} ${sharesNameWord} RegisteredHere DESC, u.CreatedAt ASC`,
            params,
        );
        return rows.map((row) => ({
            userId: String(row.Id),
            firstName: textOrNull(row.FirstName),
            lastName: textOrNull(row.LastName),
            dateOfBirth: textOrNull(row.DateOfBirth),
            gender: textOrNull(row.Gender),
            phone: textOrNull(row.PhoneNumber),
            email: textOrNull(row.Email),
            relation: textOrNull(row.Relation),
            isPrimary: bit(row.IsPrimary),
            bloodGroup: textOrNull(row.BloodGroup),
            tokenNumber: textOrNull(row.TokenNumber),
            registeredHere: bit(row.RegisteredHere),
            primary: row.PrimaryId
                ? {
                    id: String(row.PrimaryId),
                    name: `${textOrNull(row.PrimaryFirstName) ?? ""} ${textOrNull(row.PrimaryLastName) ?? ""}`.trim(),
                    firstName: textOrNull(row.PrimaryFirstName) ?? "",
                    lastName: textOrNull(row.PrimaryLastName) ?? "",
                    phone: textOrNull(row.PrimaryPhone) ?? "",
                    email: textOrNull(row.PrimaryEmail) ?? "",
                    gender: textOrNull(row.PrimaryGender) ?? "",
                    dateOfBirth: textOrNull(row.PrimaryDateOfBirth),
                    relation: textOrNull(row.PrimaryRelation) ?? "",
                    isPrimary: true,
                }
                : null,
        }));
    }

    async linkAbha(userId: string, abha: AbhaToLink, hospitalId: number | null): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            // A null number or address never clears the one already stored.
            const update: Partial<User> = { AbhaLinkedAt: new Date(), RegisteredViaAbha: true };
            if (abha.abhaNumber) update.AbhaNumber = abha.abhaNumber;
            if (abha.abhaAddress) update.AbhaAddress = abha.abhaAddress;
            await manager.getRepository(User).update(userId, update);

            for (const address of abha.abhaAddresses) {
                // A deleted patient's address is free for the record that holds the ABHA now.
                await manager.query(
                    `DELETE a FROM UserAbhaAddresses a INNER JOIN Users u ON u.Id = a.UserId WHERE a.AbhaAddress = @0 AND u.IsDeleted = 1`,
                    [address],
                );
                await manager.query(
                    `IF NOT EXISTS (SELECT 1 FROM UserAbhaAddresses WHERE UserId = @0 AND AbhaAddress = @1)
                     INSERT INTO UserAbhaAddresses (UserId, AbhaAddress) VALUES (@0, @1)`,
                    [userId, address],
                );
            }

            if (hospitalId) {
                // What this hospital's "From ABHA" filter reads.
                await manager.getRepository(PatientRegistration).update(
                    { UserId: userId, HospitalId: hospitalId, IsDeleted: false },
                    { RegisteredViaAbha: true },
                );
            }
        });
    }
}

export const abhaRepository = new AbhaRepository();
