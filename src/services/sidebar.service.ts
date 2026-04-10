import httpClient from "@/lib/httpClient";
import { API_CONFIG } from "@/config/api.config";

export interface SidebarMenuItem {
    MenuId: number;
    MenuName: string;
    Route: string | null;
    Icon: string | null;
    children?: SidebarMenuItem[];
}

export const SidebarService = {
    getSidebar: async (roleId: string, orgId?: number | null, hospId?: number | null): Promise<SidebarMenuItem[]> => {
        const url = `${API_CONFIG.ENDPOINTS.SIDEBAR}?roleId=${roleId}${orgId ? `&orgId=${orgId}` : ''}${hospId ? `&hospId=${hospId}` : ''}`;

        const response = await httpClient.get(url);
        return response.data;
    }
};

export default SidebarService;
