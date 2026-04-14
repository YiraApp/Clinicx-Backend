import { Router } from "express";
import { hospitalController } from "../../controllers/Organizations/hospital.controller.js";

const hospitalRouter = Router();

hospitalRouter.post("/createhospital", hospitalController.create.bind(hospitalController));
hospitalRouter.get("/getAllHospitals", hospitalController.getAll.bind(hospitalController));
hospitalRouter.get("/getHospitalById/:id", hospitalController.getById.bind(hospitalController));
hospitalRouter.put("/updatehospital", hospitalController.update.bind(hospitalController));
hospitalRouter.delete("/deletehospital/:id", hospitalController.delete.bind(hospitalController));

export { hospitalRouter };
