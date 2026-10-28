/**
 * Local development only: lets ABDM's callbacks reach this machine through a tunnel (ngrok)
 * without exposing the rest of the API. Forwards POST /api/v3/hip/... (M1/M2 callbacks),
 * POST /api/v3/hiu/... (M3 callbacks and the HIPs' data push) and M2's four callbacks outside those
 * (M2_PATHS) to the local backend and answers 404 to everything else, so the tunnel never serves
 * patient lists or logins.
 *
 *   npx tsx abdm-callback-proxy.ts                 listens on 5055, forwards to http://localhost:5000
 *   ngrok http 5055 --url=https://<your-ngrok-domain>
 *
 * The backend still authenticates every callback (ABDM's signed token, the HIP/HIU id, the push
 * token); this only narrows what the tunnel can reach. Bodies are streamed through, never buffered,
 * so a data push up to ABDM_DATA_PUSH_MAX_MB passes (the backend enforces that limit). Logs one line
 * per request, never a body, and never the push token of a data-push path.
 */
import http from "node:http";
import "dotenv/config";

const target = new URL(process.env.ABDM_CALLBACK_TARGET || `http://localhost:${process.env.PORT || 5000}`);
const port = Number(process.env.ABDM_CALLBACK_PROXY_PORT || 5055);
const ALLOWED_PATH = /^\/api\/v3\/(hip|hiu)\/[A-Za-z0-9/_-]+$/;
/** M2's callbacks outside /hip and /hiu (src/services/Abdm/abdm-callback.service.ts ANSWER_PATHS and REQUEST_PATHS). */
const M2_PATHS = new Set([
    "/api/v3/link/on_carecontext",
    "/api/v3/links/context/on-notify",
    "/api/v3/patients/sms/on-notify",
    "/api/v3/consent/request/hip/notify",
]);

/** A path as it may be logged: a data-push token is a credential, so it is cut out. */
const loggable = (path: string): string => path.slice(0, 120).replace(/(\/data-push\/)[^/?]*/i, "$1…");

const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0] || "";
    const shown = loggable(path);
    const requestId = String(req.headers["request-id"] || "-");
    const started = Date.now();

    if (req.method !== "POST" || !(ALLOWED_PATH.test(path) || M2_PATHS.has(path))) {
        console.log(`[proxy] refused ${req.method} ${shown}`);
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
        return;
    }

    // Which ABDM client signed the call (non-secret claims only), to set ABDM_CALLBACK_CLIENT_IDS.
    try {
        const payload = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").split(".")[1] || "";
        const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : {};
        console.log(`[proxy] caller clientId=${claims.clientId ?? "-"} azp=${claims.azp ?? "-"} iss=${claims.iss ?? "-"} hip=${req.headers["x-hip-id"] ?? "-"} hiu=${req.headers["x-hiu-id"] ?? "-"}`);
    } catch {
        console.log("[proxy] caller token unreadable");
    }

    const upstream = http.request(
        { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } },
        (answer) => {
            console.log(`[proxy] ${req.method} ${shown} REQUEST-ID=${requestId} -> ${answer.statusCode} (${Date.now() - started}ms)`);
            res.writeHead(answer.statusCode || 502, answer.headers);
            answer.pipe(res);
        },
    );
    upstream.on("error", (error) => {
        console.error(`[proxy] ${shown} REQUEST-ID=${requestId} backend unreachable: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Backend unreachable" }));
    });
    // Streamed, not buffered: no size limit here beyond the backend's own.
    req.pipe(upstream);
});

// A large push over a slow tunnel may take a while; Node's default 5-minute request timeout stays.
server.listen(port, () => {
    console.log(`[proxy] ABDM callbacks on :${port} -> ${target.origin} (only POST /api/v3/hip/..., /api/v3/hiu/... and M2's ${M2_PATHS.size} other callbacks)`);
});
