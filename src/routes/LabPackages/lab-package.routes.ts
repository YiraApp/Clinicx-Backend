import { Router } from "express";
import { labPackageController as c } from "../../controllers/LabPackages/lab-package.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";
import { upload } from "../../middlewares/upload.middleware.js";
import multer from "multer";

const labPackageRouter = Router();

// India Post's national directory CSV is larger than the usual 10 MB upload limit
const directoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// Orders: Yira System Admin (all hospitals) and hospital staff (their hospitals); checked in the service
labPackageRouter.get("/orders", authMiddleware, c.listOrders.bind(c));
labPackageRouter.put("/orders/:id/status", authMiddleware, c.updateOrderStatus.bind(c));
labPackageRouter.post("/orders/:id/report", authMiddleware, upload.single("file"), c.uploadReport.bind(c));
labPackageRouter.get("/orders/:id/report", authMiddleware, c.staffReport.bind(c));

// Visit slot timings per hospital (Lab Package Orders → Settings); same access as the orders
labPackageRouter.get("/slot-timings", authMiddleware, c.slotTimings.bind(c));
labPackageRouter.put("/slot-timings", authMiddleware, c.saveSlotTimings.bind(c));

// Pincodes for a package: India Post directory by state/district, and live search (Yira System Admin)
labPackageRouter.get("/pincodes/status", authMiddleware, c.pincodeStatus.bind(c));
labPackageRouter.post("/pincodes/import", authMiddleware, directoryUpload.single("file"), c.pincodeImport.bind(c));
labPackageRouter.post("/pincodes/fetch-series", authMiddleware, c.pincodeFetchSeries.bind(c));
labPackageRouter.get("/pincodes/states", authMiddleware, c.pincodeStates.bind(c));
labPackageRouter.get("/pincodes/districts", authMiddleware, c.pincodeDistricts.bind(c));
labPackageRouter.post("/pincodes/list", authMiddleware, c.pincodeList.bind(c));
labPackageRouter.post("/pincodes/lookup", authMiddleware, c.pincodeLookup.bind(c));
labPackageRouter.post("/pincodes/match", authMiddleware, c.pincodeMatch.bind(c));
labPackageRouter.get("/pincodes/search", authMiddleware, c.pincodeSearch.bind(c));

// Packages: Yira System Admin only
labPackageRouter.get("/test-suggestions", authMiddleware, c.testSuggestions.bind(c));
labPackageRouter.get("/", authMiddleware, c.list.bind(c));
labPackageRouter.post("/", authMiddleware, c.create.bind(c));
labPackageRouter.get("/:id", authMiddleware, c.get.bind(c));
labPackageRouter.put("/:id", authMiddleware, c.update.bind(c));
labPackageRouter.delete("/:id", authMiddleware, c.remove.bind(c));

export { labPackageRouter };
