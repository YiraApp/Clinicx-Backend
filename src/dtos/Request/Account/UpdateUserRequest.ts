import type { AddressDTO } from "./CreateUserRequest.js";

/**
 * Request DTO for updating an existing User.
 */
export interface UserRoleAssignment {
    userRoleId?: number | undefined; // Optional for existing roles
    roleId: string;
    organizationId: number;
    hospitalId?: number | undefined; // Optional for org-wide access
}

export interface UpdateUserRequest {
    Id?: string | undefined;
    FirstName: string;
    LastName?: string | undefined;
    Email?: string | undefined;
    Password?: string | undefined;
    PhoneNumber: string;
    CountryCode?: string | undefined;
    Gender?: string | undefined;
    DateOfBirth?: string | undefined;
    BloodGroup?: string | undefined;
    Relation?: string | undefined;
    ParentUserId?: string | undefined;
    Status?: boolean | undefined;
    
    PermanentAddress?: AddressDTO | undefined;
    TemporaryAddress?: AddressDTO | undefined;

    // Fallback fields (if only one address is provided, it's treated as Permanent)
    AddressLine1?: string | undefined;
    AddressLine2?: string | undefined;
    City?: string | undefined;
    State?: string | undefined;
    Pincode?: string | undefined;
    Landmark?: string | undefined;
    Country?: string | undefined;
    
    EmergencyContactName?: string | undefined;
    EmergencyContactPhone?: string | undefined;
    workspaces: UserRoleAssignment[];
}
