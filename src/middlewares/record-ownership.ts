import { isFamilyLinked } from "./request-identity.js";

/**
 * Who may delete a clinical record through the mobile API: the doctor or user
 * who created it, or, for records with no doctor (things patients add
 * themselves), the patient and their family accounts.
 */
export async function canDeleteRecord(
    requesterId: string,
    record: { PatientId?: string | null; DoctorId?: string | null; CreatedBy?: string | null; UploadedByUserId?: string | null },
): Promise<boolean> {
    const me = String(requesterId || "").toLowerCase();
    if (!me) return false;
    const same = (v?: string | null) => !!v && String(v).toLowerCase() === me;
    if (same(record.DoctorId) || same(record.CreatedBy) || same(record.UploadedByUserId)) return true;
    if (!record.DoctorId && record.PatientId) {
        return same(record.PatientId) || (await isFamilyLinked(me, String(record.PatientId)));
    }
    return false;
}

export const requesterIdOf = (req: any) => String(req?.user?.userId || req?.user?.id || "").trim();
