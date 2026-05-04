import { Router } from "express";
import { healthcareProviderController } from "../../controllers/Organizations/healthcare-provider.controller.js";

const healthcareProviderRouter = Router();

healthcareProviderRouter.post("/onboard", healthcareProviderController.onboard.bind(healthcareProviderController));
healthcareProviderRouter.get("/", healthcareProviderController.getDoctors.bind(healthcareProviderController));
healthcareProviderRouter.get("/:id", healthcareProviderController.getDoctorById.bind(healthcareProviderController));
healthcareProviderRouter.put("/:id", healthcareProviderController.update.bind(healthcareProviderController));
healthcareProviderRouter.get("/:id/slots", healthcareProviderController.getSlots.bind(healthcareProviderController));
healthcareProviderRouter.post("/:id/generate-slots", healthcareProviderController.generateSlots.bind(healthcareProviderController));

export { healthcareProviderRouter };
