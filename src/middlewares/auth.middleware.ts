import type { Request, Response, NextFunction } from "express";
import { resolveRequestIdentity } from "./request-identity.js";

/**
 * Middleware to verify JWT Access Token.
 * Attaches the decoded user payload to the request.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const identity = await resolveRequestIdentity(req);
        if (identity.failure !== undefined) {
            res.status(401).json({ error: identity.failure });
            return;
        }

        // Attach user info to the request for subsequent handlers
        (req as any).user = identity.user;

        next();
    } catch (err) {
        res.status(401).json({ error: "Authentication failed" });
    }
}

/**
 * Optional Auth Middleware: If a valid Bearer token or user header is present,
 * attaches user to request. Does not block unauthenticated access for public master data.
 */
export async function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const identity = await resolveRequestIdentity(req);
        if (identity.user) {
            (req as any).user = identity.user;
        }
    } catch (_) {}
    next();
}
