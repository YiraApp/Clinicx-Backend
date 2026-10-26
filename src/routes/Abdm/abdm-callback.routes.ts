import { Router } from "express";
import { abdmCallbackController } from "../../controllers/Abdm/abdm-callback.controller.js";
import { ANSWER_PATHS, REQUEST_PATHS } from "../../services/Abdm/abdm-callback.service.js";

/**
 * ABDM's M2 callbacks to this HIP, at <bridge URL>/api/v3/... (Scan and Share's
 * /api/v3/hip/patient/share is abdm.routes.ts's abdmCallbackRouter, mounted in app.ts ahead of
 * this one). They carry ABDM's token, not a staff login, so they sit outside staffJwtMiddleware
 * and the logging middleware's JWT check; AbdmCallbackService checks each one before anything
 * is stored.
 */
const m2CallbackRouter = Router();
const receive = abdmCallbackController.receive.bind(abdmCallbackController);

for (const path of [...ANSWER_PATHS, ...REQUEST_PATHS]) {
    m2CallbackRouter.post(path.replace(/^\/api\/v3/, ""), receive);
}

export { m2CallbackRouter };
