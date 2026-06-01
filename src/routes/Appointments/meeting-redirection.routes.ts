import { Router } from "express";
import { meetingRedirectionController } from "../../controllers/Appointments/meeting-redirection.controller.js";

const meetingRedirectionRouter = Router();

meetingRedirectionRouter.get("/:urlId", meetingRedirectionController.getRedirection.bind(meetingRedirectionController));

export { meetingRedirectionRouter };
