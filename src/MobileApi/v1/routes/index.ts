import { Router } from "express";
import { authRouter } from "./auth.routes.js";

const mobileRouterV1 = Router();

mobileRouterV1.use("/auth", authRouter);

export { mobileRouterV1 };
