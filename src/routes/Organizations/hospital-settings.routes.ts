import { Router } from "express";
import { hospitalSettingsController } from "../../controllers/Organizations/hospital-settings.controller.js";

const hospitalSettingsRouter = Router();

// Hospital Settings & Profile Flags endpoints
hospitalSettingsRouter.get("/:hospitalId/settings", hospitalSettingsController.getSettings.bind(hospitalSettingsController));
hospitalSettingsRouter.put("/:hospitalId/settings", hospitalSettingsController.saveSettings.bind(hospitalSettingsController));
hospitalSettingsRouter.get("/:hospitalId/settings/history", hospitalSettingsController.getHistory.bind(hospitalSettingsController));
hospitalSettingsRouter.post("/:hospitalId/settings/generate-slots", hospitalSettingsController.triggerSlotGeneration.bind(hospitalSettingsController));

export { hospitalSettingsRouter };
