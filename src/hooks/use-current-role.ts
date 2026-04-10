import { useAppSelector } from "@/store";
import type { Role } from "@/types/models/account/role.model";

export function useCurrentRole() {
    const selectedRole = useAppSelector((state) => state.auth.selectedRole);

    // Fallback to a safe default if no role is selected yet
    const role = (selectedRole?.RoleName as Role) || "Patient";

    return {
        role,
        selectedRole,
        isAuthenticated: !!selectedRole
    };
}
