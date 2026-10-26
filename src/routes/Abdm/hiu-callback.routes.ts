import express, { Router, type NextFunction, type Request, type Response } from "express";
import { abdmConfig } from "../../config/abdm.config.js";
import { hiuCallbackController } from "../../controllers/Abdm/hiu-callback.controller.js";

type CallbackHandlers = Pick<typeof hiuCallbackController, "onInit" | "onStatus" | "notify" | "onFetch" | "onRequest">;
type PushHandlers = Pick<typeof hiuCallbackController, "dataPushAuth" | "dataPushAddress" | "dataPush">;

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

/** The push parser's errors as JSON: 413 for a body over the limit, 400 for one that is not JSON. */
const pushParserErrors = (maxMb: number) => (error: any, _req: Request, res: Response, next: NextFunction) => {
    if (error?.type === "entity.too.large" || error?.status === 413) {
        return res.status(413).json({ error: { code: "413", message: `The page is larger than this HIU accepts (${maxMb} MB).` } });
    }
    if (error?.type === "entity.parse.failed") {
        return res.status(400).json({ error: { code: "400", message: "The body is not valid JSON." } });
    }
    const status = Number(error?.status ?? error?.statusCode);
    if (status >= 400 && status < 500) {
        return res.status(status).json({ error: { code: String(status), message: "The body could not be read." } });
    }
    return next(error);
};

/**
 * The HIPs' data push, POST /api/v3/hiu/data-push/:pushToken. app.ts mounts it at
 * /api/v3/hiu/data-push BEFORE the global express.json() (100 KB), because it has its own parser
 * with the ABDM_DATA_PUSH_MAX_MB limit. The bearer, then the push token (an open transfer inside
 * its window), are checked before the body is read.
 */
export const createHiuDataPushRouter = (c: PushHandlers = hiuCallbackController, maxMb: number = abdmConfig.dataPushMaxMb) => {
    const router = Router();
    const parser = express.json({ limit: Math.floor(maxMb * 1024 * 1024), type: ["application/json", "application/*+json"] });
    router.post("/:pushToken", c.dataPushAuth, c.dataPushAddress, parser, c.dataPush);
    router.use(pushParserErrors(maxMb));
    return router;
};

export const hiuCallbackRouter = createHiuCallbackRouter();
export const hiuDataPushRouter = createHiuDataPushRouter();
