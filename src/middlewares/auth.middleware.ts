import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt.utils.js";

/**
 * Middleware to verify JWT Access Token.
 * Attaches the decoded user payload to the request.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            res.status(401).json({ error: "No token provided or invalid format, access denied" });
            return;
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
            res.status(401).json({ error: "Access token missing" });
            return;
        }

        const payload = verifyAccessToken(token);
        if (!payload) {
            res.status(401).json({ error: "Invalid or expired access token" });
            return;
        }

        // Attach user info to the request for subsequent handlers
        (req as any).user = payload;

        next();
    } catch (err) {
        res.status(401).json({ error: "Authentication failed" });
    }
}
