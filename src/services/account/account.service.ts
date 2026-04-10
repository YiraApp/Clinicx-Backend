import httpClient from "@/lib/httpClient";
import { API_CONFIG } from "@/config/api.config";
import type { Account, UserAccountInfo } from "@/types/models/account/account.model";

export const AccountService = {
    BASE_URL: API_CONFIG.ENDPOINTS.ACCOUNTS,

    getProfile: async (): Promise<UserAccountInfo> => {
        const response = await httpClient.get(`${AccountService.BASE_URL}/profile`);
        return response.data;
    },

    updateAccount: async (accountId: string, data: Partial<Account>): Promise<Account> => {
        const response = await httpClient.patch(`${AccountService.BASE_URL}/${accountId}`, data);
        return response.data;
    },

    getAllAccounts: async (): Promise<Account[]> => {
        const response = await httpClient.get(AccountService.BASE_URL);
        return response.data;
    },
};

export default AccountService;
