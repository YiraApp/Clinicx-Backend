import { Router } from "express";
import { questionnaireController as c } from "../../controllers/Organizations/questionnaire.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

/** Mounted at /api/hospitals. Every route is for the hospital's admins, except the two for one patient at the end. */
const questionnaireRouter = Router();
const base = "/:hospitalId/questionnaire";

questionnaireRouter.get(`${base}-question-types`, authMiddleware, c.listTypes);
questionnaireRouter.put(`${base}-question-types/:id`, authMiddleware, c.updateType);

questionnaireRouter.get(`${base}-categories`, authMiddleware, c.listCategories);
questionnaireRouter.post(`${base}-categories`, authMiddleware, c.createCategory);
questionnaireRouter.put(`${base}-categories/:id`, authMiddleware, c.updateCategory);
questionnaireRouter.delete(`${base}-categories/:id`, authMiddleware, c.removeCategory);

questionnaireRouter.get(`${base}-questions`, authMiddleware, c.listQuestions);
questionnaireRouter.post(`${base}-questions`, authMiddleware, c.createQuestion);
questionnaireRouter.put(`${base}-questions/:id`, authMiddleware, c.updateQuestion);
questionnaireRouter.delete(`${base}-questions/:id`, authMiddleware, c.removeQuestion);

questionnaireRouter.get(`${base}-submissions`, authMiddleware, c.listSubmissions);
questionnaireRouter.get(`${base}-submissions/:id`, authMiddleware, c.getSubmission);

questionnaireRouter.get(`${base}-analytics/kpis`, authMiddleware, c.kpis);
questionnaireRouter.get(`${base}-analytics/breakdown`, authMiddleware, c.breakdown);
questionnaireRouter.get(`${base}-analytics/trends`, authMiddleware, c.trends);
questionnaireRouter.get(`${base}-analytics/export.csv`, authMiddleware, c.exportCsv);
questionnaireRouter.get(`${base}-analytics/insights`, authMiddleware, c.latestInsights);
questionnaireRouter.post(`${base}-analytics/insights`, authMiddleware, c.generateInsights);

questionnaireRouter.get(`${base}s`, authMiddleware, c.list);
questionnaireRouter.post(`${base}s`, authMiddleware, c.create);
questionnaireRouter.get(`${base}s/:id`, authMiddleware, c.get);
questionnaireRouter.put(`${base}s/:id`, authMiddleware, c.update);
questionnaireRouter.delete(`${base}s/:id`, authMiddleware, c.remove);
questionnaireRouter.post(`${base}s/:id/publish`, authMiddleware, c.publish);
questionnaireRouter.post(`${base}s/:id/close`, authMiddleware, c.close);
questionnaireRouter.post(`${base}s/:id/duplicate`, authMiddleware, c.duplicate);
questionnaireRouter.get(`${base}s/:id/send-preview`, authMiddleware, c.sendPreview);
questionnaireRouter.post(`${base}s/:id/send`, authMiddleware, c.send);

// For any staff member at the hospital: pick a questionnaire for one patient and send it.
questionnaireRouter.get(`${base}-patients/:patientId`, authMiddleware, c.forPatient);
questionnaireRouter.post(`${base}s/:id/send-to-patient`, authMiddleware, c.sendToPatient);

export { questionnaireRouter };
