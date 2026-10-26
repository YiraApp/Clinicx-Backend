import { AppDataSource } from "../../config/database.js";
import { AbhaConsent } from "../../models/Abdm/abha-consent.model.js";
import { User } from "../../models/Account/user.model.js";
import type { AbhaEnrolmentStore, LinkedPatient, NewAbhaConsent } from "../../services/Abdm/abha-enrolment.service.js";

/** The ABHA journey's reads and writes in the clinic database: consents, and ABHA on the Users row. */
export class AbhaRepository implements AbhaEnrolmentStore {
    private get consents() {
        return AppDataSource.getRepository(AbhaConsent);
    }

    private get users() {
        return AppDataSource.getRepository(User);
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

    async patientExists(userId: string): Promise<boolean> {
        return (await this.users.count({ where: { Id: userId, IsDeleted: false } })) > 0;
    }

    async linkAbha(userId: string, abhaNumber: string, abhaAddress: string | null): Promise<void> {
        await this.users.update(userId, { AbhaNumber: abhaNumber, AbhaAddress: abhaAddress, AbhaLinkedAt: new Date(), RegisteredViaAbha: true });
    }
}

export const abhaRepository = new AbhaRepository();
