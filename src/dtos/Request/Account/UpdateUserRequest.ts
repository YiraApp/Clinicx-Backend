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
    Relation?: string | undefined;
    ParentUserId?: string | undefined;
    Status?: boolean | undefined;
    workspaces: UserRoleAssignment[];
}
