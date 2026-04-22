import type { CreateHospitalRequest, CreateHospitalResponse, UpdateHospitalRequest } from "../../../dtos/Request/Organizations/CreateHospitalRequest.js";

export interface IHospitalService {
    createHospital(data: CreateHospitalRequest): Promise<CreateHospitalResponse>;
    updateHospital(data: UpdateHospitalRequest): Promise<any>;
    deleteHospital(id: number): Promise<void>;
    getHospitalById(id: number): Promise<any>;
    getAllHospitals(orgId?: number, page?: number, pageSize?: number, grouped?: boolean, search?: string, hospitalId?: number): Promise<any>;
}
