export interface OrgHospitalItem {
    Id: number;
    Name: string;
    HospitalCode: string | null;
    City: string | null;
    State: string | null;
    Is24Hours: boolean;
}

export interface OrgHospitalsResponse {
    OrganizationId: number;
    OrganizationName: string;
    OrgCode: string;
    Hospitals: OrgHospitalItem[];
}
