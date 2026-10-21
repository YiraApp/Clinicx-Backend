import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isInitialized = false;
let missingCredentialsLogged = false;

export const PUSH_NOT_CONFIGURED_MESSAGE =
    "Push notifications are not set up on this server. Add the Firebase service account " +
    "(FIREBASE_SERVICE_ACCOUNT setting, or a serviceAccountKey.json file) and restart the server.";

/**
 * Reads a Firebase service account from a key file's contents or an environment value.
 * Hosting dashboards alter pasted JSON in different ways, so this accepts raw JSON,
 * base64-encoded JSON and values wrapped in quotes, and repairs a private key whose
 * line breaks arrived as the two characters "\n".
 */
export function parseServiceAccount(raw: string): Record<string, any> {
    let text = (raw || "").trim();
    if (text.length > 1 && (text[0] === "'" || text[0] === '"') && text.endsWith(text[0])) {
        text = text.slice(1, -1).trim();
    }
    if (!text.startsWith("{")) {
        text = Buffer.from(text, "base64").toString("utf8").trim();
    }

    const account = JSON.parse(text);
    if (typeof account.private_key === "string") {
        account.private_key = account.private_key.replace(/\\n/g, "\n");
    }
    for (const field of ["project_id", "client_email", "private_key"]) {
        if (!account[field]) {
            throw new Error(`Firebase service account is missing "${field}".`);
        }
    }
    return account;
}

/**
 * Starts Firebase Admin if credentials are available. Returns false, and logs why once,
 * when they are not, so callers can report that push is unavailable instead of
 * treating every device as unreachable.
 */
export function initFirebaseAdmin(): boolean {
    if (isInitialized) return true;

    try {
        if (getApps().length > 0) {
            isInitialized = true;
            return true;
        }

        // Check common locations for service account key
        const keyPath = [
            process.env.GOOGLE_APPLICATION_CREDENTIALS,
            process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
            path.resolve(process.cwd(), "firebase-service-account.json"),
            path.resolve(process.cwd(), "serviceAccountKey.json"),
            path.resolve(__dirname, "../../../firebase-service-account.json"),
            path.resolve(__dirname, "../../../serviceAccountKey.json")
        ].find((p): p is string => !!p && fs.existsSync(p));

        let serviceAccount: Record<string, any>;
        let source: string;

        if (keyPath) {
            serviceAccount = parseServiceAccount(fs.readFileSync(keyPath, "utf8"));
            source = keyPath;
        } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
            source = "FIREBASE_SERVICE_ACCOUNT env variable";
        } else {
            if (!missingCredentialsLogged) {
                missingCredentialsLogged = true;
                console.error(`[FirebaseAdmin] PUSH NOTIFICATIONS ARE DISABLED. ${PUSH_NOT_CONFIGURED_MESSAGE}`);
            }
            return false;
        }

        initializeApp({
            credential: cert(serviceAccount as any)
        });
        console.log(`[FirebaseAdmin] Initialized successfully with credentials from: ${source} (project ${serviceAccount.project_id})`);
        isInitialized = true;
        return true;
    } catch (error) {
        if (!missingCredentialsLogged) {
            missingCredentialsLogged = true;
            console.error("[FirebaseAdmin] PUSH NOTIFICATIONS ARE DISABLED. The Firebase service account could not be loaded:", error);
        }
        return false;
    }
}

/** Whether this server is able to send push notifications. */
export function isPushConfigured(): boolean {
    return initFirebaseAdmin();
}

export async function sendFcmPushToTokens(
    tokens: string[],
    payload: {
        title: string;
        body: string;
        imageUrl?: string;
        type?: string;
        route?: string;
        referenceId?: string;
        additionalData?: Record<string, any>;
    }
): Promise<{
    successCount: number;
    failureCount: number;
    /** True when nothing was attempted because this server has no Firebase credentials. */
    notConfigured?: boolean;
    /** Why sends failed, as reason -> number of devices. */
    failureReasons?: Record<string, number>;
}> {
    const initialized = initFirebaseAdmin();
    if (!initialized) {
        return { successCount: 0, failureCount: tokens.length, notConfigured: true };
    }

    const messaging = getMessaging();
    let successCount = 0;
    let failureCount = 0;
    const failureReasons: Record<string, number> = {};
    const countFailure = (reason: string) => {
        failureCount++;
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    };

    const imageUrl = payload.imageUrl?.trim() || payload.additionalData?.imageUrl?.trim() || undefined;

    for (const token of tokens) {
        if (!token || token.startsWith("ios_sim_") || token === "no_token_available") {
            countFailure("simulator or placeholder token");
            continue;
        }

        try {
            const message: any = {
                token: token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                    ...(imageUrl ? { imageUrl } : {})
                },
                data: {
                    title: payload.title,
                    body: payload.body,
                    type: payload.type || "SYSTEM",
                    route: payload.route || "",
                    referenceId: payload.referenceId || "",
                    ...(imageUrl ? { imageUrl, image: imageUrl } : {}),
                    ...(payload.additionalData ? Object.fromEntries(
                        Object.entries(payload.additionalData).map(([k, v]) => [k, String(v)])
                    ) : {})
                },
                android: {
                    priority: "high" as const,
                    notification: {
                        channelId: "high_importance_channel",
                        title: payload.title,
                        body: payload.body,
                        ...(imageUrl ? { imageUrl } : {}),
                        sound: "default",
                        priority: "max" as const,
                        defaultVibrateTimings: true,
                        defaultSound: true
                    }
                },
                apns: {
                    headers: {
                        "apns-priority": "10"
                    },
                    ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
                    payload: {
                        aps: {
                            alert: {
                                title: payload.title,
                                body: payload.body
                            },
                            sound: "default",
                            badge: 1,
                            contentAvailable: true,
                            mutableContent: true
                        }
                    }
                }
            };

            const response = await messaging.send(message);
            console.log(`[FirebaseAdmin] Successfully sent FCM message to token ${token.substring(0, 15)}... ID: ${response}`);
            successCount++;
        } catch (err: any) {
            console.error(`[FirebaseAdmin] Failed to send to token ${token.substring(0, 15)}...:`, err?.message || err);

            const msg = (err?.message || "").toLowerCase();
            const code = err?.code || "";
            countFailure(String(code || err?.message || "unknown error").replace(/^messaging\//, ""));
            if (
                code === "messaging/registration-token-not-registered" ||
                code === "messaging/invalid-registration-token" ||
                msg.includes("not a valid fcm registration token") ||
                msg.includes("apns device token is disabled") ||
                msg.includes("requested entity was not found")
            ) {
                try {
                    const { userDeviceRepository } = await import("../../MobileApi/v1/repositories/userdevice.repository.js");
                    await userDeviceRepository.deactivateToken(token);
                    console.log(`[FirebaseAdmin] Deactivated stale device token ${token.substring(0, 15)}...`);
                } catch (_) {}
            }
        }
    }

    return { successCount, failureCount, failureReasons };
}
