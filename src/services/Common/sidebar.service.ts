import { sidebarRepository } from "../../repositories/Common/sidebar.repository.js";
import type { ISidebarService } from "../../interfaces/Service/Common/ISidebarService.js";

/**
 * Service to handle dynamic sidebar menu logic.
 */
export class SidebarService implements ISidebarService {
    async getSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]> {
        const roleMenus = await sidebarRepository.getRoleSidebarMenus(roleId, orgId, hospId);

        // Extract the actual menu objects
        const menus = roleMenus.map(rm => rm.Menu);

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
}

export const sidebarService = new SidebarService();
