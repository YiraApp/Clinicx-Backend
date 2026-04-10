import { RoleSidebarMenu } from "../../../models/Common/role-sidebar-menu.model.js";

/**
 * Interface for Sidebar Repository.
 */
export interface ISidebarRepository {
    getRoleSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleSidebarMenu[]>;
}
