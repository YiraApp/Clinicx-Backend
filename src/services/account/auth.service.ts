import axios from "axios";
import httpClient from "@/lib/httpClient";
import { API_CONFIG } from "@/config/api.config";

export interface UserRole {
    UserRoleId: number;
    RoleId: string;
    RoleName: string;
    OrganizationId: number | null;
    OrganizationName: string | null;
    HospitalId: number | null;
    HospitalName: string | null;
    Status: boolean;
}

export interface UserProfile {
    Id: string;
    FirstName: string;
    LastName: string;
    Email: string;
    Roles: UserRole[];
}

export interface LoginRequest {
    identity: string; // Email or Phone
    password: string;
    roleId?: string | string[];
}

export interface AuthResponse {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
    user: UserProfile;
}

export const AuthService = {
    BASE_URL: API_CONFIG.ENDPOINTS.AUTH,

    login: async (data: LoginRequest): Promise<AuthResponse> => {
        // Fetch public IP address
        let publicIp = "Unknown";
        try {
            const ipResponse = await axios.get("https://api.ipify.org?format=json");
            publicIp = ipResponse.data.ip;
        } catch (error) {
            console.warn("Failed to fetch public IP:", error);
        }

        const response = await httpClient.post(`${AuthService.BASE_URL}/login`, data, {
            headers: {
                "X-Device-Info": navigator.userAgent,
                "X-IP-Address": publicIp
            }
        });
        return response.data;
    },

    refreshTokenCall: async (token: string): Promise<{ accessToken: string, refreshToken: string }> => {
        const response = await httpClient.post(`${AuthService.BASE_URL}/refresh`, { refreshToken: token });
        return response.data;
    },

    logout: async (refreshToken?: string | null) => {
        await httpClient.post(`${AuthService.BASE_URL}/logout`, { refreshToken }).catch(() => { });
    }
};

export default AuthService;
