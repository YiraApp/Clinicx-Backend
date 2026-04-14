export interface CreateHospitalRequest {
    OrganizationId: number;
    HospitalCode: string;
    HospitalType: string;
    Name: string;
    Email?: string;
    MobileNumber: string;
    Address?: string;
    TermsAccepted?: boolean;
    roleId: string;

    // Contact
    HelplineNumber?: string;
    Website?: string;

    // Location
    City?: string;
    State?: string;
    Country?: string;
    Pincode?: string;
    Latitude?: number;
    Longitude?: number;

    // Infrastructure
    TotalBeds?: number;
    ICUBeds?: number;
    EmergencyBeds?: number;
    OperationTheatres?: number;
    Ambulances?: number;

    // Timings
    OpeningTime?: string;
    ClosingTime?: string;
    Is24Hours?: boolean;

    // Metadata
    CreatedBy?: string;
}

export interface CreateHospitalResponse {
    hospital: any;
    user: any;
}
export interface UpdateHospitalRequest extends Partial<CreateHospitalRequest> {
    Id: number;
}
