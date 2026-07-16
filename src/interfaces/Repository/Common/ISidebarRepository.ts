import { RoleSidebarMenu } from "../../../models/Common/role-sidebar-menu.model.js";
import { SidebarMenu } from "../../../models/Common/sidebar-menu.model.js";

/**
 * Interface for Sidebar Repository.
 */
export interface ISidebarRepository {
    getRoleSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<RoleSidebarMenu[]>;
    getAllMenus(): Promise<SidebarMenu[]>;
    createMenu(menuData: Partial<SidebarMenu>): Promise<SidebarMenu>;
    updateMenu(menuId: number, menuData: Partial<SidebarMenu>): Promise<SidebarMenu>;
    deleteMenu(menuId: number): Promise<void>;
    updateRoleSidebarMenus(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void>;
    hasMenuAccess(roleId: string, routePatterns: string[], orgId?: number | null, hospId?: number | null): Promise<boolean>;

    // Mobile Sidebar Operations
    getRoleMobileSidebarMenus(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]>;
    getAllMobileMenus(): Promise<any[]>;
    createMobileMenu(menuData: Partial<any>): Promise<any>;
    updateMobileMenu(menuId: number, menuData: Partial<any>): Promise<any>;
    deleteMobileMenu(menuId: number): Promise<void>;
    updateRoleMobileSidebarMenus(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void>;
}
