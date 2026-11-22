import type { Request } from "express";
import { AppDataSource } from "../config/database.js";
import { patientAccessConsentService } from "../MobileApi/v1/services/consent/patient-access-consent.service.js";
import { isDoctorAtHospital } from "../middlewares/patient-record-access.middleware.js";
import { isFamilyLinked } from "../middlewares/request-identity.js";
import { canDeleteRecord } from "../middlewares/record-ownership.js";
import { actingProfileId, sameUserId } from "./request-actor.js";
import { workingAccountId } from "./work-access.js";

interface DocumentRow {
    PatientId?: string | null;
    HospitalId?: number | null;
    AppointmentId?: number | null;
    DoctorId?: string | null;
    CreatedBy?: string | null;
    UploadedByUserId?: string | null;
}

/** True when [me] works at the document's hospital as staff other than a doctor (front desk, admins). */
async function isHospitalsStaffFor(me: string, doc: DocumentRow): Promise<boolean> {
    if (!doc.PatientId || (!doc.HospitalId && !doc.AppointmentId)) return false;
    const access = await patientAccessConsentService.checkHospitalRecordAccess(String(doc.PatientId), me, {
        hospitalId: Number(doc.HospitalId) || undefined,
        appointmentId: Number(doc.AppointmentId) || undefined,
    });
    return access.allowed && !(await isDoctorAtHospital(me, access.hospitalId));
}

/**
 * Who may read or send one document: the patient and family, a doctor they gave access to, a doctor for
 * his own records, and other staff for their hospital's. Anyone but the family needs a token to prove it.
 */
export async function canOpenDocument(req: Request, doc: DocumentRow): Promise<boolean> {
    const patientId = String(doc.PatientId || "");
    const open = actingProfileId(req);
    if (!patientId || !open) return false;
    if (await isFamilyLinked(open, patientId)) return true;

    const me = await workingAccountId(req);
    if (!me) return false;
    const consent = await patientAccessConsentService.checkAccess(patientId, me).catch(() => null);
    if (consent?.hasAccess) return true;
    if ([doc.UploadedByUserId, doc.DoctorId, doc.CreatedBy].some((id) => sameUserId(id, me))) return true;
    if (doc.AppointmentId) {
        const rows = await AppDataSource.query("SELECT TOP 1 DoctorId FROM Appointments WHERE Id = @0", [doc.AppointmentId]);
        if (sameUserId(rows?.[0]?.DoctorId, me)) return true;
    }
    // A doctor without consent gets only his own records; other staff get the hospital's.
    return isHospitalsStaffFor(me, doc);
}

/** Who may delete one on the web: whoever may delete a record, and the hospital's front desk and admins. */
export async function canDeleteDocument(req: Request, doc: DocumentRow): Promise<boolean> {
    const me = await workingAccountId(req);
    if (!me) return false;
    if (await canDeleteRecord(actingProfileId(req) || me, doc)) return true;
    return isHospitalsStaffFor(me, doc);
}
