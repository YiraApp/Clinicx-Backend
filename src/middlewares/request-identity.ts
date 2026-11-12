import type { Request } from "express";
import { AppDataSource } from "../config/database.js";
import { User } from "../models/Account/user.model.js";
import { FamilyLink } from "../models/Account/family-link.model.js";
import { verifyAccessToken } from "../utils/jwt.utils.js";
import { findByAccessToken } from "../repositories/Account/token.repository.js";

/**
 * Released mobile builds identify themselves with userId + deviceId and no token.
 * Set ALLOW_LEGACY_USER_HEADERS=false once those builds are retired; a claimed
 * identity is then only honoured on top of a valid access token.
 */
export const legacyUserHeadersAllowed = () => process.env.ALLOW_LEGACY_USER_HEADERS !== "false";

const sameId = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

const phoneKey = (phone?: string | null) => (phone ? phone.replace(/\D/g, "").slice(-10) : "");

const loadPair = (userId: string, otherUserId: string) =>
    AppDataSource.getRepository(User).find({
        where: [{ Id: userId, IsDeleted: false }, { Id: otherUserId, IsDeleted: false }],
        select: { Id: true, ParentUserId: true, PhoneNumber: true, IsPrimary: true },
    });

function samePhoneFamily(a: User, b: User): boolean {
    const rootOf = (u: User) => u.ParentUserId || u.Id;
    if (sameId(rootOf(a), rootOf(b))) return true;
    const phone = phoneKey(a.PhoneNumber);
    return phone.length === 10 && phone === phoneKey(b.PhoneNumber);
}

/** True when both accounts are in one family: same parent account or same phone number, as at login. */
export async function isSameFamily(userId: string, otherUserId: string): Promise<boolean> {
    if (sameId(userId, otherUserId)) return true;
    const users = await loadPair(userId, otherUserId);
    const [a, b] = users;
    if (users.length !== 2 || !a || !b) return false;
    return samePhoneFamily(a, b);
}

/**
 * The accounts [user] acts as for family links: itself and its account holder
 * (the parent account, or the primary account on the same phone).
 */
async function familyRootIds(user: User): Promise<string[]> {
    const ids = [user.Id];
    if (user.ParentUserId) {
        ids.push(user.ParentUserId);
    } else if (user.IsPrimary === false && phoneKey(user.PhoneNumber).length === 10) {
        const primary = await AppDataSource.getRepository(User).findOne({
            where: { PhoneNumber: user.PhoneNumber, IsPrimary: true, IsDeleted: false },
            select: { Id: true },
        });
        if (primary) ids.push(primary.Id);
    }
    return ids;
}

/** True when an accepted family link joins one of [mine] and [other], whichever side asked. */
async function hasAcceptedFamilyLink(mine: string[], other: string): Promise<boolean> {
    try {
        const count = await AppDataSource.getRepository(FamilyLink)
            .createQueryBuilder("l")
            .where("l.Status = :status", { status: "ACCEPTED" })
            .andWhere(
                "((l.RequesterUserId IN (:...mine) AND l.TargetUserId = :other) OR (l.TargetUserId IN (:...mine) AND l.RequesterUserId = :other))",
                { mine, other },
            )
            .getCount();
        return count > 0;
    } catch (error: any) {
        // Before the FamilyLinks table exists there are no links.
        console.error("[Auth] Family link check failed:", error?.message);
        return false;
    }
}

/**
 * True when [userId] may act for [otherUserId]: both are in one family (same
 * parent account or same phone number, as at login), or an accepted family
 * link joins [otherUserId] with [userId]'s own account or its account holder.
 * Links are not followed any further, so a linked person reaches only the
 * account they linked with, not its dependents or its other links.
 */
export async function isFamilyLinked(userId: string, otherUserId: string): Promise<boolean> {
    if (sameId(userId, otherUserId)) return true;
    const users = await loadPair(userId, otherUserId);
    const me = users.find((u) => sameId(u.Id, userId));
    const other = users.find((u) => sameId(u.Id, otherUserId));
    if (users.length !== 2 || !me || !other) return false;
    if (samePhoneFamily(me, other)) return true;
    return hasAcceptedFamilyLink(await familyRootIds(me), other.Id);
}

/** The userId + deviceId pair released mobile builds send in the body, query or headers. */
function legacyClaim(req: Request): string | null {
    const userId = req.body?.userId || req.query.userId || req.headers["x-user-id"];
    const deviceId = req.body?.deviceId || req.query.deviceId || req.headers["x-device-id"];
    return userId && deviceId ? String(userId) : null;
}

export type RequestIdentity = { user: any; failure?: undefined } | { user?: undefined; failure: string };

/**
 * Works out who a request acts as. A valid access token decides. The family profile
 * the app has open may replace the token's user, but only for a linked account.
 */
export async function resolveRequestIdentity(req: Request): Promise<RequestIdentity> {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : undefined;
    const claimed = legacyClaim(req);
    const allowLegacy = legacyUserHeadersAllowed();
    let failure = "No token provided, access denied";

    if (token) {
        const payload = verifyAccessToken(token);
        const record = payload ? await findByAccessToken(token) : null;
        if (payload && record && !record.IsRevoked) {
            const headerUserId = req.headers["x-user-id"];
            const profileId = claimed ?? (headerUserId ? String(headerUserId) : null);
            // tokenUserId is the signed-in account even when a family profile is open;
            // only identities proven by a token carry it.
            if (profileId && !sameId(profileId, payload.userId)) {
                if (await isFamilyLinked(payload.userId, profileId)) {
                    return { user: { ...payload, userId: profileId, tokenUserId: payload.userId } };
                }
                if (allowLegacy && claimed) {
                    console.warn(`[Auth] Legacy identity used instead of token: ${req.method} ${req.path}`);
                    return { user: { userId: claimed } };
                }
            }
            return { user: { ...payload, tokenUserId: payload.userId } };
        }
        failure = payload ? "Token has been revoked" : "Access token is invalid or expired";
    }

    if (allowLegacy && claimed) {
        console.warn(`[Auth] Legacy identity used without token: ${req.method} ${req.path}`);
        return { user: { userId: claimed } };
    }
    return { failure };
}
