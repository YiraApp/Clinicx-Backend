import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { mobileDietRouter } from "./patient-diet.routes.js";

const mobileRouterV1 = Router();

mobileRouterV1.use("/auth", authRouter);
mobileRouterV1.use("/diet", mobileDietRouter);

export { mobileRouterV1 };
