import type { Request, Response } from "express";

/**
 * The signed-in account a request is proven to come from: set by resolveRequestIdentity only
 * when the access token is valid. Requests that only claim an identity (userId + deviceId from
 * older app builds, or a token plus a claim for someone outside the family) have none.
 */
export function tokenActorId(req: Request): string | null {
    const id = (req as any).user?.tokenUserId;
    return id ? String(id).trim() : null;
}

/** The profile the request acts as (a family profile the app has open, else the signed-in account). */
export function actingProfileId(req: Request): string | null {
    const user = (req as any).user || {};
    const id = user.userId || user.Id || user.id;
    return id ? String(id).trim() : null;
}

export const sameUserId = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/** For actions on other people's data: answers 401 and returns null unless the token proves who is asking. */
export function requireTokenActor(req: Request, res: Response): string | null {
    const id = tokenActorId(req);
    if (!id) {
        res.status(401).json({
            status: false,
            message: "Please sign in again to continue.",
            code: "SIGN_IN_REQUIRED",
            data: { code: "SIGN_IN_REQUIRED" },
        });
        return null;
    }
    return id;
}
