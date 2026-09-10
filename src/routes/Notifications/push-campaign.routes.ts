import { Router } from "express";
import { pushCampaignController } from "../../controllers/Notifications/push-campaign.controller.js";

const pushCampaignRouter = Router();

pushCampaignRouter.get("/", (req, res) => pushCampaignController.getAll(req, res));
pushCampaignRouter.get("/:id", (req, res) => pushCampaignController.getById(req, res));
pushCampaignRouter.post("/", (req, res) => pushCampaignController.create(req, res));
pushCampaignRouter.put("/:id", (req, res) => pushCampaignController.update(req, res));
pushCampaignRouter.patch("/:id/toggle", (req, res) => pushCampaignController.toggleStatus(req, res));
pushCampaignRouter.delete("/:id", (req, res) => pushCampaignController.delete(req, res));
pushCampaignRouter.post("/:id/send", (req, res) => pushCampaignController.sendPush(req, res));

export { pushCampaignRouter };
