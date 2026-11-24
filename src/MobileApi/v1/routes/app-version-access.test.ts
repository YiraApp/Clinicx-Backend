import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { YIRA_SYSTEM_ADMIN_ROLE } from "../../../middlewares/yira-system-admin.middleware.js";
import { APP_VERSION_MENU, APP_VERSION_MENU_ROLE } from "../../../services/Common/migration.service.js";

// auth.routes.ts pulls in every mobile controller, so its registrations are read as text here.
// What requireYiraSystemAdmin does with a request is covered in yira-system-admin.middleware.test.ts.
const routes = readFileSync(new URL("./auth.routes.ts", import.meta.url), "utf8").split(/\r?\n/);
const registration = (method: "get" | "post", path: string) =>
    routes.map((line) => line.trim()).filter((line) => line.startsWith(`authRouter.${method}("${path}",`));

test("setting the live app version needs a signed-in Yira System Admin, not just any user", () => {
    assert.deepEqual(registration("post", "/app-version"), [
        `authRouter.post("/app-version", requireYiraSystemAdmin, registerNewAppVersion);`,
    ]);
});

test("the app's own version checks stay open, so it can check before anyone signs in", () => {
    assert.deepEqual(registration("get", "/app-version"), [`authRouter.get("/app-version", getLatestAppVersion);`]);
    assert.deepEqual(registration("post", "/app-version/status"), [`authRouter.post("/app-version/status", getVersionAndTokenStatus);`]);
});

test("the Version Management menu is seeded for the same role the save route lets in", () => {
    assert.equal(APP_VERSION_MENU_ROLE, YIRA_SYSTEM_ADMIN_ROLE);
    assert.equal(APP_VERSION_MENU.route, "/admin/app-versions");
    assert.equal(APP_VERSION_MENU.name, "Version Management");
});
