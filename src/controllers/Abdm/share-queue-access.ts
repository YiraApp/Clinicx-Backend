import { AbhaJourneyError } from "../../services/Abdm/abha-enrolment.service.js";

/** What deciding who may read a Scan and Share queue needs from the clinic database. */
export interface ShareQueueAccess {
    /** Whether the user holds an active, non-Patient role at the hospital. */
    staffWorksAt(userId: string, hospitalId: number): Promise<boolean>;
}

/**
 * The hospital whose Scan and Share queue the caller may read: the one the desk sent in
 * x-hospital-id, and only when the signed-in staff user has a role there. There is no default
 * hospital: falling back to the HIP hospital let staff of any hospital read its queue.
 */
export const shareQueueHospital = async (hospitalId: number | null, staffUserId: string, access: ShareQueueAccess): Promise<number> => {
    if (!hospitalId) {
        throw new AbhaJourneyError(400, "validation", "Switch to a hospital workspace to see its Scan and Share queue. This request did not say which hospital (x-hospital-id).");
    }
    if (!(await access.staffWorksAt(staffUserId, hospitalId))) {
        throw new AbhaJourneyError(403, "forbidden", "You don't have a staff role at this hospital, so its Scan and Share queue can't be shown.");
    }
    return hospitalId;
};
