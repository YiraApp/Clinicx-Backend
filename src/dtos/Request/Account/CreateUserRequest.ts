/**
 * Request DTO for creating a new User.
 */
export interface CreateUserRequest {
    PhoneNumber: string;
    Email?: string;
    Password?: string;
    FirstName: string;
    LastName?: string;
    Relation?: string; // Required for secondary users
    Gender?: string;
    DateOfBirth?: string;
    OrganizationId?: string;
}
