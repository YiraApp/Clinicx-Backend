import { sidebarRepository } from "../../repositories/Common/sidebar.repository.js";
import { roleRepository } from "../../repositories/Account/role.repository.js";
import type { ISidebarService } from "../../interfaces/Service/Common/ISidebarService.js";

/**
 * Service to handle dynamic sidebar menu logic.
 */
export class SidebarService implements ISidebarService {
    async getSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]> {
        let isFrontDesk = false;
        try {
            const role = await roleRepository.findById(roleId);
            if (role && role.RoleName === "Front Desk") {
                isFrontDesk = true;
            }
        } catch (err) {
            console.error("Failed to load role in sidebar service", err);
        }

        const roleMenus = await sidebarRepository.getRoleSidebarMenus(roleId, orgId, hospId);

        // Extract the actual menu objects
        const menus = roleMenus.map(rm => rm.Menu);

        // Inject in-memory Billing menu for Front Desk role if not already present
        if (isFrontDesk) {
            const hasBilling = menus.some(m => m && m.Route === "/frontdesk/billing");
            if (!hasBilling) {
                menus.push({
                    MenuId: 99999,
                    MenuName: "Billing",
                    Route: "/frontdesk/billing",
                    Icon: "CreditCard",
                    OrderNo: 6,
                    Status: true,
                    CreatedAt: new Date()
                } as any);
            }
        }

        // Build hierarchy
        const menuMap = new Map<number, any>();
        const rootMenus: any[] = [];

        // 1. Initialize map and find roots
        menus.forEach(menu => {
            menuMap.set(menu.MenuId, { ...menu, children: [] });
        });

        // 2. Link children to parents
        menuMap.forEach(menu => {
            if (menu.ParentMenuId && menuMap.has(menu.ParentMenuId)) {
                const parent = menuMap.get(menu.ParentMenuId);
                parent.children.push(menu);
                // Sort children by OrderNo
                parent.children.sort((a: any, b: any) => (a.OrderNo || 0) - (b.OrderNo || 0));
            } else if (!menu.ParentMenuId) {
                // It's a root menu
                rootMenus.push(menu);
            }
            // Note: If a menu has a ParentMenuId but that parent isn't assigned to this role, 
            // the menu will be treated as root or orphan depending on requirements.
            // Following the 'role-based' rule, we only show what's in menuMap.
            else if (!menuMap.has(menu.ParentMenuId)) {
                rootMenus.push(menu);
            }
        });

        // 3. Final sort of root menus
        const finalMenu = rootMenus.sort((a: any, b: any) => (a.OrderNo || 0) - (b.OrderNo || 0));

        return finalMenu;
    }

    async getAllMenus(): Promise<any[]> {
        return await sidebarRepository.getAllMenus();
    }

    async createMenu(menuData: any): Promise<any> {
        return await sidebarRepository.createMenu(menuData);
    }

    async updateMenu(menuId: number, menuData: any): Promise<any> {
        return await sidebarRepository.updateMenu(menuId, menuData);
    }

    async deleteMenu(menuId: number): Promise<void> {
        await sidebarRepository.deleteMenu(menuId);
    }

    async updateSidebarPermissions(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void> {
        await sidebarRepository.updateRoleSidebarMenus(roleId, menuIds, orgId, hospId);
    }

    // Mobile Sidebar Operations
    async getMobileSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]> {
        const roleMenus = await sidebarRepository.getRoleMobileSidebarMenus(roleId, orgId, hospId);
        const menus = roleMenus.map(rm => rm.Menu);
        return menus.sort((a: any, b: any) => (a.OrderNo || 0) - (b.OrderNo || 0));
    }

    async getAllMobileMenus(): Promise<any[]> {
        return await sidebarRepository.getAllMobileMenus();
    }

    async createMobileMenu(menuData: any): Promise<any> {
        return await sidebarRepository.createMobileMenu(menuData);
    }

    async updateMobileMenu(menuId: number, menuData: any): Promise<any> {
        return await sidebarRepository.updateMobileMenu(menuId, menuData);
    }

    async deleteMobileMenu(menuId: number): Promise<void> {
        await sidebarRepository.deleteMobileMenu(menuId);
    }

    async updateMobileSidebarPermissions(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void> {
        await sidebarRepository.updateRoleMobileSidebarMenus(roleId, menuIds, orgId, hospId);
    }
}

export const sidebarService = new SidebarService();
