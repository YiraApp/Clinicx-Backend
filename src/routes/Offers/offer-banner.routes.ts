import { Router } from "express";
import { offerBannerController } from "../../controllers/Offers/offer-banner.controller.js";

const offerBannerRouter = Router();

offerBannerRouter.get("/", (req, res) => offerBannerController.getAll(req, res));
offerBannerRouter.get("/:id", (req, res) => offerBannerController.getById(req, res));
offerBannerRouter.post("/", (req, res) => offerBannerController.create(req, res));
offerBannerRouter.put("/:id", (req, res) => offerBannerController.update(req, res));
offerBannerRouter.patch("/:id/toggle", (req, res) => offerBannerController.toggleStatus(req, res));
offerBannerRouter.delete("/:id", (req, res) => offerBannerController.delete(req, res));
offerBannerRouter.post("/:id/send-push", (req, res) => offerBannerController.sendPush(req, res));

export { offerBannerRouter };
