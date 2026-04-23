import { Router } from "express";
import { getSidebar, getAllMenus, assignSidebarPermissions, createMenu, updateMenu, deleteMenu } from "../../controllers/Common/sidebar.controller.js";

const sidebarRouter = Router();

// --- Sidebar Menu Management (Admin Only) ---
sidebarRouter.get("/menus", getAllMenus);
sidebarRouter.post("/menus", createMenu);
sidebarRouter.put("/menus/:id", updateMenu);
sidebarRouter.delete("/menus/:id", deleteMenu);

// --- Permissions Assignment ---
sidebarRouter.get("/", getSidebar);
sidebarRouter.post("/assign", assignSidebarPermissions);

export { sidebarRouter };
