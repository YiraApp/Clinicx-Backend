import { Router } from "express";
import { healthcareProviderController } from "../../controllers/Organizations/healthcare-provider.controller.js";

const healthcareProviderRouter = Router();

healthcareProviderRouter.post("/onboard", healthcareProviderController.onboard.bind(healthcareProviderController));

export { healthcareProviderRouter };
