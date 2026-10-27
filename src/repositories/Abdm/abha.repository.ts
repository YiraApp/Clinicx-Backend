import { AppDataSource } from "../../config/database.js";
import { AbhaConsent } from "../../models/Abdm/abha-consent.model.js";
import { User } from "../../models/Account/user.model.js";
import { PatientRegistration } from "../../models/Organizations/patient-registration.model.js";
import { Hospital } from "../../models/Organizations/hospital.model.js";
import type { HipHospitalLookup } from "../../services/Abdm/abdm-bridge.service.js";
import type { AbhaEnrolmentStore, AbhaToLink, LinkedPatient, NewAbhaConsent } from "../../services/Abdm/abha-enrolment.service.js";

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

    async findPatientByAbhaNumber(abhaNumber: string): Promise<LinkedPatient | null> {
        const user = await this.users.findOne({
            where: { AbhaNumber: abhaNumber, IsDeleted: false },
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
