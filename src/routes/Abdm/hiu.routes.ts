import { Router } from "express";
import { hiuController as c } from "../../controllers/Abdm/hiu.controller.js";

/**
 * The HIU staff API, mounted by abdm.routes.ts at /api/abdm/hiu behind staffJwtMiddleware and
 * abdmHiuAccess (role and hospital verified in the database).
 */
const hiuRouter = Router();

hiuRouter.get("/options", c.options);
hiuRouter.get("/patients/:userId/abha", c.patientAbha);
hiuRouter.post("/consent-requests", c.create);
hiuRouter.get("/consent-requests", c.list);
hiuRouter.get("/consent-requests/:id", c.detail);
hiuRouter.post("/consent-requests/:id/refresh-status", c.refreshStatus);
hiuRouter.get("/artefacts/:id/records", c.records);
hiuRouter.get("/artefacts/:id/records/:recordId", c.record);
hiuRouter.post("/artefacts/:id/request-records", c.requestRecords);

export { hiuRouter };
