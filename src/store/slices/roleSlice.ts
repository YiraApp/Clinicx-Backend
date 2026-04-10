import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { RoleService } from "@/services/account/role.service";
import type { ApiRole } from "@/types/models/account/api-role.model";

export interface RoleState {
    roles: ApiRole[];
    isLoading: boolean;
    error: string | null;
}

const initialState: RoleState = {
    roles: [],
    isLoading: false,
    error: null,
};

export const fetchRoles = createAsyncThunk(
    "role/fetchRoles",
    async () => {
        return await RoleService.getRoles();
    }
);

const roleSlice = createSlice({
    name: "role",
    initialState,
    reducers: {},
    extraReducers: (builder) => {
        builder
            .addCase(fetchRoles.pending, (state) => {
                state.isLoading = true;
                state.error = null;
            })
            .addCase(fetchRoles.fulfilled, (state, action) => {
                state.isLoading = false;
                state.roles = action.payload;
            })
            .addCase(fetchRoles.rejected, (state, action) => {
                state.isLoading = false;
                state.error = action.error.message || "Failed to fetch roles";
            });
    },
});

export default roleSlice.reducer;
