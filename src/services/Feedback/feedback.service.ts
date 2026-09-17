import { feedbackRepository } from "../../repositories/Feedback/feedback.repository.js";
import { hospitalRepository } from "../../repositories/Organizations/hospital.repository.js";
import { organizationRepository } from "../../repositories/Organizations/organization.repository.js";
import { defaultOrganizationRepository } from "../../repositories/Organizations/default-organization.repository.js";
import { userRepository } from "../../repositories/Account/user.repository.js";
import { Feedback } from "../../models/Feedback/feedback.model.js";

export class FeedbackService {

    async submitFeedback(data: {
        userId?: string;
        name: string;
        phone?: string;
        email?: string;
        rating: number;
        category?: string;
        message: string;
        hospitalId?: number;
        organizationId?: number;
        source?: string;
    }): Promise<Feedback> {
        if (!data.name || !data.name.trim()) {
            throw new Error("Name is required to submit feedback.");
        }

        if (!data.message || !data.message.trim()) {
            throw new Error("Feedback message is required.");
        }

        const rating = Math.min(5, Math.max(1, Number(data.rating) || 5));
        let hospitalId = data.hospitalId ? Number(data.hospitalId) : undefined;
        let organizationId = data.organizationId ? Number(data.organizationId) : undefined;
        let hospitalName: string | undefined = undefined;
        let organizationName: string | undefined = undefined;

        // Resolve Hospital & Organization details
        if (hospitalId) {
            try {
                const hosp = await hospitalRepository.findById(hospitalId);
                if (hosp) {
                    hospitalName = hosp.Name;
                    if (!organizationId && hosp.OrganizationId) {
                        organizationId = hosp.OrganizationId;
                    }
                }
            } catch (err) {
                console.warn("[FeedbackService] Hospital lookup warning:", err);
            }
        }

        if (organizationId) {
            try {
                const org = await organizationRepository.findById(organizationId);
                if (org) {
                    organizationName = org.Name;
                }
            } catch (err) {
                console.warn("[FeedbackService] Org lookup warning:", err);
            }
        }

        // If neither hospital nor org was specified, fallback to active DefaultOrganization
        if (!hospitalId && !organizationId) {
            try {
                const activeDefault = await defaultOrganizationRepository.getActiveDefault();
                if (activeDefault) {
                    if (activeDefault.HospitalId) {
                        hospitalId = activeDefault.HospitalId;
                        hospitalName = activeDefault.HospitalName || undefined;
                    }
                    if (activeDefault.OrganizationId) {
                        organizationId = activeDefault.OrganizationId;
                        organizationName = activeDefault.OrganizationName || undefined;
                    }
                }
            } catch (err) {
                console.warn("[FeedbackService] Default org lookup warning:", err);
            }
        }

        // Corroborate User details if userId is supplied
        let validUserId: string | null = null;
        if (data.userId) {
            const trimmed = String(data.userId).trim();
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(trimmed)) {
                validUserId = trimmed;
                try {
                    const existingUser = await userRepository.findById(validUserId);
                    if (existingUser) {
                        if (!data.phone && existingUser.PhoneNumber) {
                            data.phone = existingUser.PhoneNumber;
                        }
                        if (!data.email && existingUser.Email) {
                            data.email = existingUser.Email;
                        }
                    }
                } catch (err) {
                    console.warn("[FeedbackService] User lookup warning:", err);
                }
            }
        }

        const source = data.source || (validUserId ? "UserLink" : "Public");

        const feedback = await feedbackRepository.create({
            UserId: validUserId,
            Name: data.name.trim(),
            Phone: data.phone?.trim() || null,
            Email: data.email?.trim() || null,
            Rating: rating,
            Category: data.category?.trim() || "General",
            Message: data.message.trim(),
            HospitalId: hospitalId || null,
            HospitalName: hospitalName || null,
            OrganizationId: organizationId || null,
            OrganizationName: organizationName || null,
            Source: source,
            Status: "New"
        });

        console.log(`[FeedbackService] Feedback submitted successfully (ID: ${feedback.Id}, Rating: ${feedback.Rating}, Source: ${source})`);
        return feedback;
    }

    async getUserFeedbackContext(userId: string): Promise<{
        userId: string;
        name: string;
        phone: string | null;
        email: string | null;
        hospitalId: number | null;
        hospitalName: string | null;
        organizationId: number | null;
    } | null> {
        const trimmed = String(userId).trim();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(trimmed)) {
            return null;
        }

        const user = await userRepository.findById(trimmed);
        if (!user) {
            return null;
        }

        const fullName = `${user.FirstName || ""} ${user.LastName || ""}`.trim() || "Valued Patient";

        let hospitalId: number | null = null;
        let hospitalName: string | null = null;
        let organizationId: number | null = null;

        try {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault) {
                hospitalId = activeDefault.HospitalId || 19;
                hospitalName = activeDefault.HospitalName || "Yira Hospitals";
                organizationId = activeDefault.OrganizationId || 1;
            }
        } catch (e) {
            // fallback
        }

        return {
            userId: user.Id,
            name: fullName,
            phone: user.PhoneNumber || null,
            email: user.Email || null,
            hospitalId,
            hospitalName,
            organizationId
        };
    }

    async getDefaultFeedbackContext(): Promise<{
        hospitalId: number;
        hospitalName: string;
        organizationId: number;
        organizationName: string;
    }> {
        let hospitalId = 19;
        let hospitalName = "Yira Hospitals";
        let organizationId = 1;
        let organizationName = "Yira Health System";

        try {
            const activeDefault = await defaultOrganizationRepository.getActiveDefault();
            if (activeDefault) {
                if (activeDefault.HospitalId) hospitalId = activeDefault.HospitalId;
                if (activeDefault.HospitalName) hospitalName = activeDefault.HospitalName;
                if (activeDefault.OrganizationId) organizationId = activeDefault.OrganizationId;
                if (activeDefault.OrganizationName) organizationName = activeDefault.OrganizationName;
            }
        } catch (e) {
            // fallback defaults
        }

        return {
            hospitalId,
            hospitalName,
            organizationId,
            organizationName
        };
    }

    async getFeedbacks(filters: {
        orgId?: number;
        hospitalId?: number;
        userId?: string;
        rating?: number;
        category?: string;
        status?: string;
        search?: string;
        page?: number;
        pageSize?: number;
    }) {
        return await feedbackRepository.findWithFilters(filters);
    }

    async getFeedbackStats(orgId?: number, hospitalId?: number) {
        return await feedbackRepository.getStats(orgId, hospitalId);
    }

    async updateStatus(id: number, status: string, adminNotes?: string) {
        return await feedbackRepository.updateStatus(id, status, adminNotes);
    }
}

export const feedbackService = new FeedbackService();
