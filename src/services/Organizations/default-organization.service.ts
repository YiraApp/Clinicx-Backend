import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";
import { organizationRepository } from "../../repositories/Organizations/organization.repository.js";
import { hospitalRepository } from "../../repositories/Organizations/hospital.repository.js";
import type { CreateDefaultOrganizationRequest } from "../../dtos/Request/Organizations/CreateDefaultOrganizationRequest.js";
import type { UpdateDefaultOrganizationRequest } from "../../dtos/Request/Organizations/UpdateDefaultOrganizationRequest.js";
import type { DefaultOrganizationResponse } from "../../dtos/Response/Organizations/DefaultOrganizationResponse.js";
import type { DefaultOrganization } from "../../models/Organizations/default-organization.model.js";

export class DefaultOrganizationService {
    /**
     * Creates and sets a new Default Organization record.
     * Ensures ONLY ONE record has IsDefault = true at a time.
     */
    async createDefaultOrganization(request: CreateDefaultOrganizationRequest): Promise<DefaultOrganizationResponse> {
        if (!request.OrganizationId) {
            throw new Error("OrganizationId is required.");
        }

        if (!request.HospitalId) {
            throw new Error("HospitalId is required.");
        }

        const org = await organizationRepository.findById(request.OrganizationId);
        if (!org) {
            throw new Error(`Organization with ID ${request.OrganizationId} not found.`);
        }

        const hospital = await hospitalRepository.findById(request.HospitalId);
        if (!hospital) {
            throw new Error(`Hospital with ID ${request.HospitalId} not found.`);
        }
        const hospitalName = hospital.Name;

        const isDefault = request.IsDefault !== false; // Defaults to true if not specified

        // Check if an entry for this exact Organization and Hospital already exists
        const existingEntry = await defaultOrganizationRepository.findByOrgAndHospital(
            request.OrganizationId,
            request.HospitalId
        );

        // Ensure only one default exists at any given time
        if (isDefault) {
            await defaultOrganizationRepository.resetAllDefaults();
        }

        if (existingEntry) {
            // Update existing entry instead of creating a duplicate
            const updated = await defaultOrganizationRepository.updateDefaultOrg(existingEntry.Id, {
                OrganizationName: org.Name,
                HospitalName: hospitalName,
                IsDefault: isDefault,
                Status: request.Status ?? true,
                UpdatedBy: request.CreatedBy || "System Admin"
            });

            return this.mapToResponse(updated || existingEntry);
        }

        const newDefaultOrg = await defaultOrganizationRepository.createDefaultOrg({
            OrganizationId: request.OrganizationId,
            HospitalId: request.HospitalId ?? undefined,
            OrganizationName: org.Name,
            HospitalName: hospitalName,
            IsDefault: isDefault,
            Status: request.Status ?? true,
            CreatedBy: request.CreatedBy || "System Admin"
        });

        return this.mapToResponse(newDefaultOrg);
    }

    /**
     * Updates an existing Default Organization record.
     * If setting IsDefault = true, resets all other defaults so only one remains active.
     */
    async updateDefaultOrganization(request: UpdateDefaultOrganizationRequest): Promise<DefaultOrganizationResponse> {
        if (!request.Id) {
            throw new Error("Id is required to update a default organization record.");
        }

        const existing = await defaultOrganizationRepository.findById(request.Id);
        if (!existing) {
            throw new Error(`Default Organization record with ID ${request.Id} not found.`);
        }

        let orgName = existing.OrganizationName;
        if (request.OrganizationId && request.OrganizationId !== existing.OrganizationId) {
            const org = await organizationRepository.findById(request.OrganizationId);
            if (!org) {
                throw new Error(`Organization with ID ${request.OrganizationId} not found.`);
            }
            orgName = org.Name;
        }

        let hospitalName = existing.HospitalName;
        if (request.HospitalId !== undefined) {
            if (request.HospitalId) {
                const hospital = await hospitalRepository.findById(request.HospitalId);
                if (!hospital) {
                    throw new Error(`Hospital with ID ${request.HospitalId} not found.`);
                }
                hospitalName = hospital.Name;
            } else {
                hospitalName = undefined;
            }
        }

        // If setting this record as default, reset all other defaults
        if (request.IsDefault === true) {
            await defaultOrganizationRepository.resetAllDefaults();
        }

        const updated = await defaultOrganizationRepository.updateDefaultOrg(request.Id, {
            OrganizationId: request.OrganizationId ?? existing.OrganizationId,
            HospitalId: request.HospitalId !== undefined ? (request.HospitalId ?? undefined) : existing.HospitalId,
            OrganizationName: orgName ?? undefined,
            HospitalName: hospitalName ?? undefined,
            IsDefault: request.IsDefault !== undefined ? request.IsDefault : existing.IsDefault,
            Status: request.Status !== undefined ? request.Status : existing.Status,
            UpdatedBy: request.UpdatedBy || "System Admin"
        });

        if (!updated) {
            throw new Error("Failed to update Default Organization record.");
        }

        return this.mapToResponse(updated);
    }

    /**
     * Fetches the current active default organization and hospital setting.
     */
    async getActiveDefaultOrganization(): Promise<DefaultOrganizationResponse | null> {
        const activeDefault = await defaultOrganizationRepository.getActiveDefault();
        if (!activeDefault) {
            return null;
        }
        return this.mapToResponse(activeDefault);
    }

    /**
     * Fetches all default organization records.
     */
    async getAllDefaultOrganizations(): Promise<DefaultOrganizationResponse[]> {
        const records = await defaultOrganizationRepository.getAll();
        return records.map(r => this.mapToResponse(r));
    }

    private mapToResponse(entity: DefaultOrganization): DefaultOrganizationResponse {
        return {
            Id: entity.Id,
            OrganizationId: entity.OrganizationId,
            HospitalId: entity.HospitalId,
            OrganizationName: entity.OrganizationName || entity.Organization?.Name || null,
            HospitalName: entity.HospitalName || entity.Hospital?.Name || null,
            IsDefault: entity.IsDefault,
            Status: entity.Status,
            CreatedAt: entity.CreatedAt,
            UpdatedAt: entity.UpdatedAt ?? null,
            CreatedBy: entity.CreatedBy ?? null,
            UpdatedBy: entity.UpdatedBy ?? null
        };
    }
}

export const defaultOrganizationService = new DefaultOrganizationService();
