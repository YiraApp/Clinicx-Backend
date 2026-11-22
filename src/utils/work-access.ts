import type { Request, Response } from "express";
import { AppDataSource } from "../config/database.js";
import { HealthcareProvider } from "../models/Organizations/healthcare-provider.model.js";
import { isFamilyLinked, isSameFamily } from "../middlewares/request-identity.js";
import { canManageHospitalSetup } from "./hospital-admin-access.js";
import { actingProfileId, requireTokenActor, sameUserId, tokenActorId } from "./request-actor.js";

/**
 * Who works on other people's data in this request. The token must prove it. An open profile counts
 * only on the same login (parent account or phone): a linked family member never works as that doctor.
 */
export async function workingAccountId(req: Request): Promise<string | null> {
    const signedIn = tokenActorId(req);
    if (!signedIn) return null;
    const open = actingProfileId(req);
    if (!open || sameUserId(open, signedIn)) return signedIn;
    return (await isSameFamily(signedIn, open)) ? open : signedIn;
}

/** A doctor's user id, also when a provider row's numeric id was sent. */
export async function doctorUserIdOf(doctorId: unknown): Promise<string | null> {
    const id = String(doctorId ?? "").trim();
    if (!/^\d+$/.test(id)) return id || null;
    const provider = await AppDataSource.getRepository(HealthcareProvider).findOne({ where: { Id: Number(id), IsDeleted: false } });
    return provider?.UserId ?? null;
}

export async function isDoctor(userId: string): Promise<boolean> {
    return (await AppDataSource.getRepository(HealthcareProvider).count({ where: { UserId: userId, IsDeleted: false } })) > 0;
}

/**
 * A doctor's lists and dashboards are for that doctor, and for the front desk and admins of a hospital
 * he works at. [familyView] lets someone who is no doctor open their own or their family's appointments.
 * Answers the request and returns false otherwise.
 */
export async function requireDoctorView(
    req: Request,
    res: Response,
    doctorId: unknown,
    hospitalId?: number,
    { familyView = false } = {},
): Promise<boolean> {
    const doctor = await doctorUserIdOf(doctorId);
    const deny = () => {
        res.status(403).json({ status: false, message: "You can only see your own patients and schedule." });
        return false;
    };
    if (!doctor) return deny();

    if (familyView && !(await isDoctor(doctor))) {
        const open = actingProfileId(req);
        return open && (await isFamilyLinked(open, doctor)) ? true : deny();
    }
    if (!requireTokenActor(req, res)) return false;
    const me = await workingAccountId(req);
    if (!me) return deny();
    if (sameUserId(me, doctor)) return true;

    const hospital = Number(hospitalId) || 0;
    if (hospital > 0 && (await canManageHospitalSetup(me, hospital))) {
        const worksThere = await AppDataSource.getRepository(HealthcareProvider).count({
            where: { UserId: doctor, HospitalId: hospital, IsDeleted: false },
        });
        if (worksThere > 0) return true;
    }
    return deny();
}
