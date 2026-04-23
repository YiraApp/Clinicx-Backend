import type { Request, Response } from "express";
import { healthcareProviderService } from "../../services/Organizations/healthcare-provider.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class HealthcareProviderController {
    async onboard(req: Request, res: Response) {
        try {
            const result = await healthcareProviderService.onboardProvider(req.body);
            return res.json(ApiResponse.success(result, "Provider onboarded successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const healthcareProviderController = new HealthcareProviderController();
