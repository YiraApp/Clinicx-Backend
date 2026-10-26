import type { Request, Response } from "express";
import { AbdmCallbackService } from "../../services/Abdm/abdm-callback.service.js";
import { abdmExchangeRepository } from "../../repositories/Abdm/abdm-exchange.repository.js";
import { abdmCallbackAuth } from "../../services/Abdm/abdm-callback-auth.service.js";
import { m2CallbackHandlers } from "../../services/Abdm/m2/index.js";

const abdmCallbackService = new AbdmCallbackService(abdmExchangeRepository, abdmCallbackAuth, () => new Date(), m2CallbackHandlers);

/** ABDM's posts to the bridge: answered with a status at once, and with no body on success. */
export class AbdmCallbackController {
    async receive(req: Request, res: Response) {
        try {
            const outcome = await abdmCallbackService.receive({ path: req.originalUrl, headers: req.headers, body: req.body });
            if (outcome.status === 202) {
                return res.status(202).send("");
            }
            return res.status(outcome.status).json({ error: { message: outcome.reason } });
        } catch (error: any) {
            // Nothing was stored: a 5xx lets ABDM deliver it again.
            console.error(`[ABDM] callback ${req.path} failed before it was stored:`, error?.message);
            return res.status(500).json({ error: { message: "The callback could not be stored." } });
        }
    }
}

export const abdmCallbackController = new AbdmCallbackController();
