import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { abdmConfig } from "../../config/abdm.config.js";
import { hiuCallbackController } from "../../controllers/Abdm/hiu-callback.controller.js";

type CallbackHandlers = Pick<typeof hiuCallbackController, "onInit" | "onStatus" | "notify" | "onFetch" | "onRequest">;
type PushHandlers = Pick<typeof hiuCallbackController, "dataPushAuth" | "dataPushAddress" | "dataPush" | "dataPushRefused">;

/**
 * ABDM's gateway callbacks to this HIU, mounted by app.ts at /api/v3/hiu after the global JSON
 * parser and before the user-login middleware (ABDM appends these paths to the bridge URL).
 */
export const createHiuCallbackRouter = (c: CallbackHandlers = hiuCallbackController) => {
    const router = Router();
    router.post("/consent/request/on-init", c.onInit);
    router.post("/consent/request/on-status", c.onStatus);
    router.post("/consent/request/notify", c.notify);
    router.post("/consent/on-fetch", c.onFetch);
    router.post("/health-information/on-request", c.onRequest);
    return router;
};

/** What the push parser raises for a body that is not JSON, answered 400 by pushParserErrors. */
const notJson = (): Error => Object.assign(new Error("The body is not valid JSON."), { type: "entity.parse.failed", status: 400, expose: true });

/**
 * The push body, read as bytes whatever its Content-Type and parsed as JSON here. HIPs send
 * application/json, text/plain, a charset express.json refuses, or no Content-Type at all; the page
 * is JSON either way. The size limit is the same (413 past it), a leading byte-order mark is
 * dropped, an empty body is {} as express.json makes it, and anything else that is not JSON is 400.
 * A body declared UTF-16 (charset=utf-16, utf-16le or utf-16be) is read as UTF-16, as express.json
 * read it; every other charset is read as UTF-8.
 */
const pushJsonParser = (maxMb: number): RequestHandler[] => [
    express.raw({ limit: Math.floor(maxMb * 1024 * 1024), type: () => true }),
    (req: Request, _res: Response, next: NextFunction) => {
        if (!Buffer.isBuffer(req.body)) return next();
        const charset = (/charset\s*=\s*"?([\w-]+)/i.exec(String(req.headers["content-type"] ?? ""))?.[1] ?? "").toLowerCase();
        const encoding = /^utf-16(le|be)?$/.test(charset) ? charset : "utf-8";
        let text: string;
        try {
            // TextDecoder drops a byte-order mark that matches the encoding.
            text = new TextDecoder(encoding).decode(req.body).replace(/^\uFEFF/, "");
        } catch {
            req.body = undefined;
            return next(notJson());
        }
        if (text.length === 0) {
            req.body = {};
            return next();
        }
        try {
            req.body = JSON.parse(text);
        } catch {
            req.body = undefined;
            return next(notJson());
        }
        next();
    },
];

/**
 * The push parser's errors as JSON: 413 for a body over the limit, 400 for one that is not JSON.
 * In the push route itself (so the push token is in req.params) each is recorded against its
 * transfer through [refused] (PUSH_REFUSED), after the answer.
 */
const pushParserErrors = (maxMb: number, refused?: PushHandlers["dataPushRefused"]) => (error: any, req: Request, res: Response, next: NextFunction) => {
    if (error?.type === "entity.too.large" || error?.status === 413) {
        res.status(413).json({ error: { code: "413", message: `The page is larger than this HIU accepts (${maxMb} MB).` } });
        refused?.(req, 413, `page too large (over ${maxMb} MB)`);
        return;
    }
    if (error?.type === "entity.parse.failed") {
        res.status(400).json({ error: { code: "400", message: "The body is not valid JSON." } });
        refused?.(req, 400, "not JSON");
        return;
    }
    const status = Number(error?.status ?? error?.statusCode);
    if (status >= 400 && status < 500) {
        res.status(status).json({ error: { code: String(status), message: "The body could not be read." } });
        refused?.(req, status, `body could not be read (${String(error?.type ?? "error").replace(/[^a-z.]/gi, "").slice(0, 40)})`);
        return;
    }
    return next(error);
};

/**
 * The HIPs' data push, POST /api/v3/hiu/data-push/:pushToken. app.ts mounts it at
 * /api/v3/hiu/data-push BEFORE the global express.json() (100 KB), because it has its own parser
 * with the ABDM_DATA_PUSH_MAX_MB limit, which takes any Content-Type. The bearer, then the push
 * token (an open transfer inside its window), are checked before the body is read.
 */
export const createHiuDataPushRouter = (c: PushHandlers = hiuCallbackController, maxMb: number = abdmConfig.dataPushMaxMb) => {
    const router = Router();
    router.post("/:pushToken", c.dataPushAuth, c.dataPushAddress, ...pushJsonParser(maxMb), pushParserErrors(maxMb, c.dataPushRefused), c.dataPush);
    // Anything that still escapes the route is answered the same way, unrecorded.
    router.use(pushParserErrors(maxMb));
    return router;
};

export const hiuCallbackRouter = createHiuCallbackRouter();
export const hiuDataPushRouter = createHiuDataPushRouter();
