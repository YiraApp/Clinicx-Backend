import type { Role } from "./role.model";

export interface Account {
    id: string;
    organizationCode: string;
    organizationName: string;
    accountReference: string;
    status: "active" | "inactive" | "suspended";
    createdAt: string;
    updatedAt: string;
}

export interface UserAccountInfo {
    userId: string;
    email: string;
    role: Role;
    userName: string;
    accounts: Account[];
}
