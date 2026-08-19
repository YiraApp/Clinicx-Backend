/**
 * DTO for address details.
 */
export interface AddressDTO {
    AddressLine1?: string | undefined;
    AddressLine2?: string | undefined;
    City?: string | undefined;
    State?: string | undefined;
    Pincode?: string | undefined;
    Landmark?: string | undefined;
    Country?: string | undefined;
}

/**
 * Request DTO for creating a new User.
 */
export interface CreateUserRequest {
    PhoneNumber: string;
    CountryCode?: string | undefined;
    Email?: string | undefined;
    Password?: string | undefined;
    FirstName: string;
    LastName?: string | undefined;
    Relation?: string | undefined; // Required for secondary users
    Gender?: string | undefined;
    DateOfBirth?: string | undefined;
    BloodGroup?: string | undefined;
    OrganizationId?: string | undefined;
    RoleName?: string | undefined;
    OrganizationName?: string | undefined;
    RoleMessage?: string | undefined;
    LoginURL?: string | undefined;
    IsMobileVerified?: boolean | undefined;
    IsEmailVerified?: boolean | undefined;
    Height?: number | undefined;
    Weight?: number | undefined;
    TokenNumber?: string | undefined;
    Token?: string | undefined;
    
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
}
