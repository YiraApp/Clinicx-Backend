/**
 * Interface for Sidebar Service.
 */
export interface ISidebarService {
    getSidebarMenu(roleId: string, orgId?: number | null, hospId?: number | null): Promise<any[]>;
}
