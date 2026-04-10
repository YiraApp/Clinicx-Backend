import type { Request, Response, NextFunction } from "express";

/**
 * Middleware to check user's roles for authorization.
 * @param allowedRoles - An array of strings representing the required roles.
 */
export function roleMiddleware(allowedRoles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            // Placeholder: Replace with logic to extract user roles from req.body, req.user etc.
            const userRole = (req as any).user?.role;

            if (!allowedRoles.includes(userRole)) {
                res.status(403).json({ error: "Access denied: Insufficient permissions" });
                return;
            }

            next();
        } catch (err) {
            res.status(500).json({ error: "Internal Server Error" });
        }
    };
}
