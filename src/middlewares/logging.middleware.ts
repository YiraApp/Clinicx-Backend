import type { Request, Response, NextFunction } from "express";
import { AppDataSource } from "../config/database.js";
import { APILog } from "../models/Logs/apilog.model.js";
import { verifyAccessToken } from "../utils/jwt.utils.js";
import { findByAccessToken } from "../repositories/Account/token.repository.js";
import dotenv from "dotenv";

dotenv.config();

const apiLogRepository = AppDataSource.getRepository(APILog);

/**
 * Global combined middleware for structured request logging and JWT authentication.
 * Inspired by the C# LoggingMiddleware.
 */
export const loggingMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const requestedOn = new Date();

    // Whitelist for public endpoints that skip JWT validation
    const publicRoutes = ["/api/auth/login", "/api/auth/refresh", "/api/auth/register", "/health", "/api/roles", "/favicon.ico", "/robots.txt"];
    const isPublic = publicRoutes.some(route => req.path.startsWith(route));

    console.log(`[DEBUG] Request: ${req.method} ${req.path} | isPublic: ${isPublic}`);

    // Capture initial request metadata
    const requestLog = new APILog();
    requestLog.Method = req.method;
    requestLog.Path = req.path;
    requestLog.QueryString = JSON.stringify(req.query);
    requestLog.RequestBody = JSON.stringify(req.body);
    requestLog.RequestHeaders = JSON.stringify(req.headers);
    requestLog.RequestedOn = requestedOn;

    let isSaved = false;
    const saveLog = async () => {
        if (isSaved) return;
        isSaved = true;
        await apiLogRepository.save(requestLog).catch(err => {
            console.error("Error saving API log:", err);
        });
    };

    try {
        // Step 1: Intercept response to capture body and status (Set this up FIRST)
        const originalSend = res.send;
        res.send = function (body: any) {
            const durationMs = Date.now() - startTime;
            requestLog.Response = typeof body === "string" ? body : JSON.stringify(body);
            requestLog.ResponseStatusCode = res.statusCode;
            requestLog.ResponseTimeMs = durationMs;
            requestLog.UpdatedOn = new Date();

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

            // Attach user ID to the request object for downstream use
            (req as any).userId = payload.userId;
        }

        next();
    } catch (error: any) {
        // Step 4: Handle middleware errors
        const durationMs = Date.now() - startTime;
        console.error("Critical error in loggingMiddleware:", error);

        res.status(500).json({ error: "Internal Server Error", detail: error.message });

        requestLog.Response = JSON.stringify({ error: "Internal Server Error", detail: error.message });
        requestLog.ResponseStatusCode = 500;
        requestLog.ResponseTimeMs = durationMs;
        requestLog.UpdatedOn = new Date();
        saveLog();
    }
};
