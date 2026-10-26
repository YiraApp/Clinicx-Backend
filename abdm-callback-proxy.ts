/**
 * Local development only: lets ABDM's callbacks reach this machine through a tunnel (ngrok)
 * without exposing the rest of the API. Forwards POST /api/v3/hip/... to the local backend and
 * answers 404 to everything else, so the tunnel never serves patient lists or logins.
 *
 *   npx tsx abdm-callback-proxy.ts                 listens on 5055, forwards to http://localhost:5000
 *   ngrok http 5055 --url=https://<your-ngrok-domain>
 *
 * The backend still authenticates every callback (ABDM's signed token, the HIP id); this only
 * narrows what the tunnel can reach. Logs one line per request, never a body.
 */
import http from "node:http";
import "dotenv/config";

const target = new URL(process.env.ABDM_CALLBACK_TARGET || `http://localhost:${process.env.PORT || 5000}`);
const port = Number(process.env.ABDM_CALLBACK_PROXY_PORT || 5055);
const ALLOWED_PATH = /^\/api\/v3\/hip\/[A-Za-z0-9/_-]+$/;

const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0] || "";
    const requestId = String(req.headers["request-id"] || "-");
    const started = Date.now();

    if (req.method !== "POST" || !ALLOWED_PATH.test(path)) {
        console.log(`[proxy] refused ${req.method} ${path.slice(0, 120)}`);
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
        return;
    }

    // Which ABDM client signed the call (non-secret claims only), to set ABDM_CALLBACK_CLIENT_IDS.
    try {
        const payload = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").split(".")[1] || "";
        const claims = payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : {};
        console.log(`[proxy] caller clientId=${claims.clientId ?? "-"} azp=${claims.azp ?? "-"} iss=${claims.iss ?? "-"} hip=${req.headers["x-hip-id"] ?? "-"}`);
    } catch {
        console.log("[proxy] caller token unreadable");
    }

    const upstream = http.request(
        { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } },
        (answer) => {
            console.log(`[proxy] ${req.method} ${path} REQUEST-ID=${requestId} -> ${answer.statusCode} (${Date.now() - started}ms)`);
            res.writeHead(answer.statusCode || 502, answer.headers);
            answer.pipe(res);
        },
    );
    upstream.on("error", (error) => {
        console.error(`[proxy] ${path} REQUEST-ID=${requestId} backend unreachable: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Backend unreachable" }));
    });
    req.pipe(upstream);
});

server.listen(port, () => {
    console.log(`[proxy] ABDM callbacks on :${port} -> ${target.origin} (only POST /api/v3/hip/...)`);
});
