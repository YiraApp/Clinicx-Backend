/**
 * Interface for Sidebar Service.
 */
export interface ISidebarService {
    getSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]>;
    getAllMenus(): Promise<any[]>;
    createMenu(menuData: any): Promise<any>;
    updateMenu(menuId: number, menuData: any): Promise<any>;
    deleteMenu(menuId: number): Promise<void>;
    updateSidebarPermissions(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void>;

    // Mobile Sidebar Operations
    getMobileSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]>;
    getAllMobileMenus(): Promise<any[]>;
    createMobileMenu(menuData: any): Promise<any>;
    updateMobileMenu(menuId: number, menuData: any): Promise<any>;
    deleteMobileMenu(menuId: number): Promise<void>;
    updateMobileSidebarPermissions(roleId: string, menuIds: number[], orgId?: number | null, hospId?: number | null): Promise<void>;
}
