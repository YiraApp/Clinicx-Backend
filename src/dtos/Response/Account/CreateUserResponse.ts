/**
 * Response DTO for User creation.
 */
export interface CreateUserResponse {
    Id: string;
    PhoneNumber: string;
    IsPrimary: boolean;
    Message: string;
}
