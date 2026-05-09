import { Router } from "express";
import { snomedController } from "./snomed.controller.js";

const snomedRouter = Router();

snomedRouter.get("/search", snomedController.search);
snomedRouter.get("/ucum-codes", snomedController.getUcumCodes);

export { snomedRouter };
