import type { Request } from "express";
import { AppDataSource } from "../config/database.js";
import { User } from "../models/Account/user.model.js";
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

/** True when both accounts are in one family: same parent account or same phone number, as at login. */
export async function isFamilyLinked(userId: string, otherUserId: string): Promise<boolean> {
    if (sameId(userId, otherUserId)) return true;
    const users = await AppDataSource.getRepository(User).find({
        where: [{ Id: userId, IsDeleted: false }, { Id: otherUserId, IsDeleted: false }],
        select: { Id: true, ParentUserId: true, PhoneNumber: true },
    });
    const [a, b] = users;
    if (users.length !== 2 || !a || !b) return false;

    const rootOf = (u: User) => u.ParentUserId || u.Id;
    if (sameId(rootOf(a), rootOf(b))) return true;
    const phone = phoneKey(a.PhoneNumber);
    return phone.length === 10 && phone === phoneKey(b.PhoneNumber);
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
            if (profileId && !sameId(profileId, payload.userId)) {
                if (await isFamilyLinked(payload.userId, profileId)) {
                    return { user: { ...payload, userId: profileId } };
                }
                if (allowLegacy && claimed) {
                    console.warn(`[Auth] Legacy identity used instead of token: ${req.method} ${req.path}`);
                    return { user: { userId: claimed } };
                }
            }
            return { user: payload };
        }
        failure = payload ? "Token has been revoked" : "Access token is invalid or expired";
    }

    if (allowLegacy && claimed) {
        console.warn(`[Auth] Legacy identity used without token: ${req.method} ${req.path}`);
        return { user: { userId: claimed } };
    }
    return { failure };
}
