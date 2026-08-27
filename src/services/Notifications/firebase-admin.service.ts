import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isInitialized = false;

export function initFirebaseAdmin(): boolean {
    if (isInitialized) return true;

    try {
        if (getApps().length > 0) {
            isInitialized = true;
            return true;
        }

        // Check common locations for service account key
        const potentialPaths = [
            process.env.GOOGLE_APPLICATION_CREDENTIALS,
            process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
            path.resolve(process.cwd(), "firebase-service-account.json"),
            path.resolve(process.cwd(), "serviceAccountKey.json"),
            path.resolve(__dirname, "../../../firebase-service-account.json"),
            path.resolve(__dirname, "../../../serviceAccountKey.json")
        ].filter((p): p is string => !!p && fs.existsSync(p));

        if (potentialPaths.length > 0) {
            const keyPath = potentialPaths[0];
            const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
            initializeApp({
                credential: cert(serviceAccount)
            });
            console.log(`[FirebaseAdmin] Initialized successfully with credentials from: ${keyPath}`);
            isInitialized = true;
            return true;
        } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            initializeApp({
                credential: cert(serviceAccount)
            });
            console.log("[FirebaseAdmin] Initialized successfully from FIREBASE_SERVICE_ACCOUNT env variable.");
            isInitialized = true;
            return true;
        } else {
            console.log("[FirebaseAdmin] Notice: No serviceAccountKey.json file found yet. Drop your Firebase Admin private key JSON into Clinicx-Backend to enable live remote push dispatch.");
            return false;
        }
    } catch (error) {
        console.error("[FirebaseAdmin] Initialization error:", error);
        return false;
    }
}

export async function sendFcmPushToTokens(
    tokens: string[],
    payload: {
        title: string;
        body: string;
        type?: string;
        route?: string;
        referenceId?: string;
        additionalData?: Record<string, any>;
    }
): Promise<{ successCount: number; failureCount: number }> {
    const initialized = initFirebaseAdmin();
    if (!initialized) {
        return { successCount: 0, failureCount: tokens.length };
    }

    const messaging = getMessaging();
    let successCount = 0;
    let failureCount = 0;

    for (const token of tokens) {
        if (!token || token.startsWith("ios_sim_") || token === "no_token_available") {
            continue;
        }

        try {
            const message = {
                token: token,
                notification: {
                    title: payload.title,
                    body: payload.body
                },
                data: {
                    title: payload.title,
                    body: payload.body,
                    type: payload.type || "SYSTEM",
                    route: payload.route || "",
                    referenceId: payload.referenceId || "",
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
                    payload: {
                        aps: {
                            alert: {
                                title: payload.title,
                                body: payload.body
                            },
                            sound: "default",
                            badge: 1,
                            contentAvailable: true
                        }
                    }
                }
            };

            const response = await messaging.send(message);
            console.log(`[FirebaseAdmin] Successfully sent FCM message to token ${token.substring(0, 15)}... ID: ${response}`);
            successCount++;
        } catch (err: any) {
            console.error(`[FirebaseAdmin] Failed to send to token ${token.substring(0, 15)}...:`, err?.message || err);
            failureCount++;
        }
    }

    return { successCount, failureCount };
}
