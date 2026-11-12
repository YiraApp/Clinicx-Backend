import type { Request, Response } from "express";
import { ApiResponse } from "../../../utils/response.utils.js";
import { isSameFamily } from "../../../middlewares/request-identity.js";
import { familyLinkService, FamilyLinkError } from "../../../services/Family/family-link.service.js";
import type { User } from "../../../models/Account/user.model.js";

/**
 * Family links between people who each have their own Yira account.
 * Everything here acts for the signed-in account holder. A profile opened
 * through a family link can't manage that person's links, codes or requests.
 */
async function accountHolderOf(req: Request): Promise<User> {
    const user = (req as any).user;
    const tokenUserId = user?.tokenUserId ? String(user.tokenUserId) : "";
    const activeId = user?.userId ? String(user.userId) : "";
    // Only an identity proven by an access token may manage family links.
    if (!tokenUserId || !activeId) {
        throw new FamilyLinkError("Please sign in again to manage your family.", 401, "SIGN_IN_REQUIRED");
    }
    if (!(await isSameFamily(tokenUserId, activeId))) {
        throw new FamilyLinkError("Switch back to your own profile to manage family links.", 403, "SWITCH_TO_OWN_PROFILE");
    }
    return familyLinkService.resolveAccountHolder(activeId);
}

function fail(res: Response, error: any, fallback: string) {
    if (error instanceof FamilyLinkError) {
        return res.status(error.status).json({
            status: false,
            message: error.message,
            data: { code: error.code, ...(error.extra || {}) },
        });
    }
    console.error(`[Family] ${fallback}:`, error?.message);
    return res.status(500).json({ status: false, message: fallback, data: { code: "SERVER_ERROR" } });
}

const idParam = (req: Request) => Number.parseInt(String(req.params.id ?? ""), 10);

export class FamilyController {
    /** GET /family/code: the code that works now (a new one once the last has run out). */
    async getCode(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.getCurrentCode(holder.Id), "Family code"));
        } catch (error) {
            return fail(res, error, "Could not load your family code");
        }
    }

    /** POST /family/code/refresh: stops the current code and issues a new one. */
    async refreshCode(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.refreshCode(holder.Id), "New family code"));
        } catch (error) {
            return fail(res, error, "Could not make a new family code");
        }
    }

    /** POST /family/lookup { phone }: found or not, with a masked name only. */
    async lookup(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            const result = await familyLinkService.lookup(holder, req.body?.phone);
            return res.json(ApiResponse.success(result, result.found ? "Account found" : "No account uses this number"));
        } catch (error) {
            return fail(res, error, "Could not look up this number");
        }
    }

    /**
     * POST /family/link-with-code { phone, familyCode, relation }: linked at once.
     * "familyCode" is masked in the API logs; "code" is accepted too.
     */
    async linkWithCode(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            const { phone, familyCode, code, relation } = req.body || {};
            const result = await familyLinkService.linkWithCode(holder, phone, familyCode ?? code, relation);
            return res.json(ApiResponse.success(result, "Linked to your family"));
        } catch (error) {
            return fail(res, error, "Could not link this person");
        }
    }

    /** POST /family/requests { phone, relation }: asks the other person to accept. */
    async sendRequest(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            const { phone, relation } = req.body || {};
            const result = await familyLinkService.sendRequest(holder, phone, relation);
            return res.json(ApiResponse.success(result, result.status === "ACCEPTED" ? "Linked to your family" : "Request sent"));
        } catch (error) {
            return fail(res, error, "Could not send the request");
        }
    }

    /** GET /family/requests: { incoming, outgoing } open requests. */
    async listRequests(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.listRequests(holder), "Family requests"));
        } catch (error) {
            return fail(res, error, "Could not load family requests");
        }
    }

    /** POST /family/requests/:id/accept { relation? } */
    async accept(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            const result = await familyLinkService.acceptRequest(holder, idParam(req), req.body?.relation);
            return res.json(ApiResponse.success(result, "Linked to your family"));
        } catch (error) {
            return fail(res, error, "Could not accept the request");
        }
    }

    /** POST /family/requests/:id/decline */
    async decline(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.declineRequest(holder, idParam(req)), "Request declined"));
        } catch (error) {
            return fail(res, error, "Could not decline the request");
        }
    }

    /** POST /family/requests/:id/cancel */
    async cancel(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.cancelRequest(holder, idParam(req)), "Request cancelled"));
        } catch (error) {
            return fail(res, error, "Could not cancel the request");
        }
    }

    /** GET /family/members: dependents and linked accounts, with the family-size limit. */
    async listMembers(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.listMembers(holder), "Family members"));
        } catch (error) {
            return fail(res, error, "Could not load your family");
        }
    }

    /** DELETE /family/links/:id (or POST /family/links/:id/remove): either side ends the link. */
    async removeLink(req: Request, res: Response) {
        try {
            const holder = await accountHolderOf(req);
            return res.json(ApiResponse.success(await familyLinkService.removeLink(holder, idParam(req)), "Removed from your family"));
        } catch (error) {
            return fail(res, error, "Could not remove this person");
        }
    }
}

export const familyController = new FamilyController();
