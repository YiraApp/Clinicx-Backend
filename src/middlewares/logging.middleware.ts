import type { Request, Response, NextFunction } from "express";
import { AppDataSource } from "../config/database.js";
import { APILog } from "../models/Logs/apilog.model.js";
import { verifyAccessToken } from "../utils/jwt.utils.js";
import { findByAccessToken } from "../repositories/Account/token.repository.js";

const apiLogRepository = AppDataSource.getRepository(APILog);

/**
 * Global combined middleware for structured request logging and JWT authentication.
 * Inspired by the C# LoggingMiddleware.
 */
export const loggingMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const requestedOn = new Date();

    // Whitelist for public endpoints that skip JWT validation
    const publicRoutes = ["/api/auth/login", "/api/auth/refresh", "/api/auth/register", "/health", "/api/roles", "/api/consent/request", "/api/consent/submit", "/favicon.ico", "/robots.txt", "/api/test-sms", "/api/clinical-summary/share"];


    const isPublic = publicRoutes.some(route => req.path.startsWith(route));

    // Capture initial request metadata
    const requestLog = new APILog();
    requestLog.Method = req.method;
    requestLog.Path = req.path;
    requestLog.QueryString = JSON.stringify(req.query);
    requestLog.RequestedOn = requestedOn;

    // Capture Network & Device Info
    let clientIp: string = "";
    const xForwardedFor = req.headers["x-forwarded-for"];
    if (Array.isArray(xForwardedFor)) {
        clientIp = xForwardedFor[0] || "";
    } else if (typeof xForwardedFor === "string") {
        clientIp = xForwardedFor;
    } else {
        clientIp = (req.headers["x-real-ip"] as string) || req.ip || req.socket?.remoteAddress || "";
    }
    const ip = (clientIp as any).split(",")[0].trim();

    requestLog.IPAddress = ip;
    requestLog.DeviceInfo = (req.headers["user-agent"] || "").substring(0, 500);

    if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEBUG] Audit Log IP: ${ip} | Path: ${req.path}`);
    }

    // Truncate and mask RequestBody
    if (req.body) {
        let body = { ...req.body };
        if (body.password) body.password = "********";
        if (body.Password) body.Password = "********";
        const bodyStr = JSON.stringify(body);
        requestLog.RequestBody = bodyStr.length > 2000 ? bodyStr.substring(0, 2000) + "... [truncated]" : bodyStr;
    }

    requestLog.RequestHeaders = JSON.stringify(req.headers).substring(0, 2000);

    // Capture Audit Tracking (Action, EntityId, EntityType)
    const pathParts = req.path.split("/").filter((p: string) => p && p !== "api");
    if (pathParts.length > 0) {
        requestLog.EntityType = pathParts[0] || null;
        if (pathParts.length > 1) {
            const secondPart = pathParts[1];
            if (secondPart && (/^[0-9a-fA-F-]{36}$/.test(secondPart) || /^\d+$/.test(secondPart))) {
                requestLog.EntityId = secondPart;
            }
        }

        if (req.method === "POST") {
            requestLog.Action = req.path.includes("login") ? "LOGIN" : "CREATE";
        } else if (req.method === "PUT" || req.method === "PATCH") {
            requestLog.Action = "UPDATE";
        } else if (req.method === "DELETE") {
            requestLog.Action = "DELETE";
        } else {
            requestLog.Action = "READ";
        }
    }

    let isSaved = false;
    const saveLog = async () => {
        if (isSaved) return;
        isSaved = true;

        // Populate User Context from Request (set by authMiddleware or later in this middleware)
        const userId = (req as any).userId || (req as any).user?.userId;
        if (userId) requestLog.UserId = userId;

        // Capture Role & Org Context from Headers
        const roleId = req.headers["x-role-id"] as string | undefined;
        const roleName = req.headers["x-role-name"] as string | undefined;
        const orgId = req.headers["x-org-id"] as string | undefined;
        const hospitalId = req.headers["x-hospital-id"] as string | undefined;

        if (roleId) requestLog.RoleId = roleId;
        if (roleName) requestLog.RoleName = roleName;

        // Role-based Org/Hospital logic
        const parsedOrgId = orgId ? parseInt(orgId) : null;
        const parsedHospitalId = hospitalId ? parseInt(hospitalId) : null;

        if (roleName === "Yira System Admin") {
            requestLog.OrgId = null;
            requestLog.HospitalId = null;
        } else if (roleName === "Org Admin") {
            requestLog.OrgId = isNaN(Number(parsedOrgId)) ? null : (parsedOrgId as any);
            requestLog.HospitalId = null;
        } else if (roleName) {
            // Hospital Admin / Provider / Front Desk / Patient
            requestLog.OrgId = isNaN(Number(parsedOrgId)) ? null : (parsedOrgId as any);
            requestLog.HospitalId = isNaN(Number(parsedHospitalId)) ? null : (parsedHospitalId as any);
        }

        // Async Location Lookup (if IP is valid and not local)
        const isLocal = ip === "::1" || ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.");
        
        if (isLocal) {
            requestLog.Location = "Local";
        } else if (ip && !requestLog.Location) {
            try {
                // Using ipapi.co (supports HTTPS and more detailed data)
                const locResponse = await fetch(`https://ipapi.co/${ip}/json/`);
                if (locResponse.ok) {
                    const locData = await locResponse.json() as any;
                    if (!locData.error) {
                        requestLog.Location = `${locData.city}, ${locData.region}, ${locData.country_name}`;
                    }
                }
            } catch (err) {
                // Silently fail location lookup
            }
        }

        // Save log asynchronously
        apiLogRepository.save(requestLog).catch(err => {
            console.error("Error saving API log:", err);
        });
    };

    try {
        // Step 1: Intercept response to capture body and status
        const originalSend = res.send;
        res.send = function (body: any) {
            const durationMs = Date.now() - startTime;
            
            let responseStr = "";
            if (typeof body === "string") {
                responseStr = body;
            } else {
                try {
                    responseStr = JSON.stringify(body);
                } catch (e) {
                    responseStr = "[Unserializable Response]";
                }
            }

            requestLog.Response = responseStr.length > 2000 ? responseStr.substring(0, 2000) + "... [truncated]" : responseStr;
            requestLog.ResponseStatusCode = res.statusCode;
            requestLog.ResponseTimeMs = durationMs;
            requestLog.UpdatedOn = new Date();

            // Fire and forget
            saveLog();
            return originalSend.apply(res, arguments as any);
        };

        // Step 2: JWT Authentication for protected routes
        if (!isPublic) {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                res.status(401).json({ error: "No token provided, access denied" });
                return;
            }

            const token = authHeader.split(" ")[1];
            const payload = verifyAccessToken(token!);

            if (!payload) {
                res.status(401).json({ error: "Access token is invalid or expired" });
                return;
            }

            // Step 3: Database check for token revocation
            const tokenRecord = await findByAccessToken(token!);
            if (!tokenRecord || tokenRecord.IsRevoked) {
                res.status(401).json({ error: "Token has been revoked" });
                return;
            }

            // Attach user ID to the request object
            (req as any).userId = payload.userId;
            (req as any).user = payload; // For compatibility
        }

        next();
    } catch (error: any) {
        // Step 4: Handle middleware errors
        const durationMs = Date.now() - startTime;
        console.error("Critical error in loggingMiddleware:", error);

        if (!res.headersSent) {
            res.status(500).json({ error: "Internal Server Error", detail: error.message });
        }

        requestLog.Response = JSON.stringify({ error: "Internal Server Error", detail: error.message });
        requestLog.ResponseStatusCode = 500;
        requestLog.ResponseTimeMs = durationMs;
        requestLog.UpdatedOn = new Date();
        saveLog();
    }
};
