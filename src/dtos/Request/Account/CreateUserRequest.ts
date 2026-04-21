/**
 * Request DTO for creating a new User.
 */
export interface CreateUserRequest {
    PhoneNumber: string;
    Email?: string | undefined;
    Password?: string | undefined;
    FirstName: string;
    LastName?: string | undefined;
    Relation?: string | undefined; // Required for secondary users
    Gender?: string | undefined;
    DateOfBirth?: string | undefined;
    OrganizationId?: string | undefined;
    RoleName?: string | undefined;
    OrganizationName?: string | undefined;
    RoleMessage?: string | undefined;
    LoginURL?: string | undefined;
    IsMobileVerified?: boolean | undefined;
    IsEmailVerified?: boolean | undefined;
}
