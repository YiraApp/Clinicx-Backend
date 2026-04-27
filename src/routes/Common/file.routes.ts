import { Router } from "express";
import { fileController } from "../../controllers/Common/file.controller.js";
import { upload } from "../../middlewares/upload.middleware.js";

const router = Router();

// Route for uploading multiple files
// Supports up to 10 files at once
router.post("/upload", upload.array("files", 10), (req, res) => fileController.uploadFiles(req, res));

export default router;
