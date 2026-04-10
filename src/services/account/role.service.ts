import httpClient from "@/lib/httpClient";
import { API_CONFIG } from "@/config/api.config";
import type { ApiRole } from "@/types/models/account/api-role.model";

export const RoleService = {
    BASE_URL: API_CONFIG.ENDPOINTS.ROLES,

    /**
     * Fetch all available roles from the public API
     * Endpoint: {BASE_URL}/api/roles/getRoles
     */
    getRoles: async (): Promise<ApiRole[]> => {
        const response = await httpClient.get(`${RoleService.BASE_URL}/getRoles`);
        return response.data;
    }
};

export default RoleService;
