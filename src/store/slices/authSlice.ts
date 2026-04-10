import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import AuthService from "@/services/account/auth.service";
import type { UserProfile, UserRole, AuthResponse } from "@/services/account/auth.service";
import type { SidebarMenuItem } from "@/services/sidebar.service";

export interface AuthState {
    user: UserProfile | null;
    tokens: {
        accessToken: string | null;
        refreshToken: string | null;
        accessTokenExpiry: string | null;
        refreshTokenExpiry: string | null;
    } | null;
    selectedRole: UserRole | null;
    sidebarMenu: SidebarMenuItem[] | null;
    isAuthenticated: boolean;
}

// Initial state from localStorage to persist sessions
const getInitialState = (): AuthState => {
    try {
        const accessToken = localStorage.getItem("token");
        const refreshToken = localStorage.getItem("refreshToken");
        const accessTokenExpiry = localStorage.getItem("accessTokenExpiry");
        const refreshTokenExpiry = localStorage.getItem("refreshTokenExpiry");
        const user = localStorage.getItem("userProfile");
        const selectedRole = localStorage.getItem("selectedRole");
        const sidebarMenu = localStorage.getItem("sidebarMenu");

        return {
            user: user ? JSON.parse(user) : null,
            tokens: accessToken ? {
                accessToken,
                refreshToken,
                accessTokenExpiry,
                refreshTokenExpiry
            } : null,
            selectedRole: selectedRole ? JSON.parse(selectedRole) : null,
            sidebarMenu: sidebarMenu ? JSON.parse(sidebarMenu) : null,
            isAuthenticated: !!accessToken,
        };
    } catch {
        return {
            user: null,
            tokens: null,
            selectedRole: null,
            sidebarMenu: null,
            isAuthenticated: false,
        };
    }
};

const initialState: AuthState = getInitialState();

export const performLogout = createAsyncThunk(
    "auth/performLogout",
    async (_, { getState, dispatch }) => {
        const state = getState() as { auth: AuthState };
        const refreshToken = state.auth.tokens?.refreshToken;

        // Notify backend to revoke the token
        try {
            await AuthService.logout(refreshToken);
        } catch (error) {
            console.warn("Logout API call failed, proceeding with local cleanup", error);
        }

        // Trigger local state cleanup
        dispatch(authSlice.actions.logout());
    }
);

const authSlice = createSlice({
    name: "auth",
    initialState,
    reducers: {
        loginSuccess: (state, action: PayloadAction<{ response: AuthResponse; selectedRole: UserRole }>) => {
            const { accessToken, refreshToken, accessTokenExpiry, refreshTokenExpiry, user } = action.payload.response;

            state.user = user;
            state.tokens = {
                accessToken,
                refreshToken,
                accessTokenExpiry,
                refreshTokenExpiry
            };
            state.selectedRole = action.payload.selectedRole;
            state.isAuthenticated = true;

            // Persistence
            localStorage.setItem("token", accessToken);
            localStorage.setItem("refreshToken", refreshToken);
            localStorage.setItem("accessTokenExpiry", accessTokenExpiry);
            localStorage.setItem("refreshTokenExpiry", refreshTokenExpiry);
            localStorage.setItem("userProfile", JSON.stringify(user));
            localStorage.setItem("selectedRole", JSON.stringify(action.payload.selectedRole));
            localStorage.setItem("userRole", action.payload.selectedRole.RoleName);
            localStorage.setItem("userName", `${user.FirstName} ${user.LastName}`);
        },
        logout: (state) => {
            state.user = null;
            state.tokens = null;
            state.selectedRole = null;
            state.sidebarMenu = null;
            state.isAuthenticated = false;

            // Clear ALL persistence for security
            localStorage.clear();
            sessionStorage.clear();
        },
        updateSelectedRole: (state, action: PayloadAction<UserRole>) => {
            state.selectedRole = action.payload;
            localStorage.setItem("selectedRole", JSON.stringify(action.payload));
            localStorage.setItem("userRole", action.payload.RoleName);
        },
        setSidebarMenu: (state, action: PayloadAction<SidebarMenuItem[]>) => {
            state.sidebarMenu = action.payload;
            localStorage.setItem("sidebarMenu", JSON.stringify(action.payload));
        }
    },
});

export const { loginSuccess, logout, updateSelectedRole, setSidebarMenu } = authSlice.actions;
export default authSlice.reducer;
