import { Request, Response } from "express";
import { clinicalNoteService } from "../../../../services/Appointments/clinical-note.service.js";
import { ApiResponse } from "../../../../utils/response.utils.js";

export class MobileClinicalNoteController {
    async getPatientNotes(req: Request, res: Response) {
        try {
            const patientId = (req.params.patientId || req.query.patientId || req.body.patientId) as string;
            const { orgId, hospitalId, appointmentId } = req.query;

            const parsedOrgId = orgId ? parseInt(String(orgId)) : undefined;
            const parsedHospitalId = hospitalId ? parseInt(String(hospitalId)) : undefined;
            const parsedAppointmentId = appointmentId ? parseInt(String(appointmentId)) : undefined;

            if (!patientId) {
                return res.status(400).json(ApiResponse.error("Patient ID is required"));
            }

            const notes = await clinicalNoteService.getPatientNotes(
                patientId,
                isNaN(parsedOrgId as any) ? undefined : parsedOrgId,
                isNaN(parsedHospitalId as any) ? undefined : parsedHospitalId,
                isNaN(parsedAppointmentId as any) ? undefined : parsedAppointmentId
            );

            return res.json(ApiResponse.success(notes, "Clinical notes fetched successfully"));
        } catch (error: any) {
            console.error("Mobile Clinical Note Get Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async addNote(req: Request, res: Response) {
        try {
            const { appointmentId, doctorId, patientId, notes, organizationId, hospitalId, createdBy } = req.body;

            if (!patientId || !notes) {
                return res.status(400).json(ApiResponse.error("Patient ID and notes are required"));
            }

            const noteData = {
                appointmentId: appointmentId ? parseInt(String(appointmentId)) : undefined,
                doctorId: doctorId || (req as any).user?.userId,
                patientId,
                notes,
                organizationId: organizationId ? parseInt(String(organizationId)) : undefined,
                hospitalId: hospitalId ? parseInt(String(hospitalId)) : undefined,
                createdBy: createdBy || (req as any).user?.firstName || "Doctor"
            };

            const result = await clinicalNoteService.addNote(noteData);
            return res.status(201).json(ApiResponse.success(result, "Clinical note saved successfully"));
        } catch (error: any) {
            console.error("Mobile Clinical Note Add Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async updateNote(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { notes, updatedBy } = req.body;

            if (!id || !notes) {
                return res.status(400).json(ApiResponse.error("Note ID and notes are required"));
            }

            await clinicalNoteService.updateNote(parseInt(String(id)), notes, updatedBy || "Doctor");
            return res.json(ApiResponse.success(null, "Clinical note updated successfully"));
        } catch (error: any) {
            console.error("Mobile Clinical Note Update Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }

    async deleteNote(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id) {
                return res.status(400).json(ApiResponse.error("Note ID is required"));
            }

            await clinicalNoteService.deleteNote(parseInt(String(id)));
            return res.json(ApiResponse.success(null, "Clinical note deleted successfully"));
        } catch (error: any) {
            console.error("Mobile Clinical Note Delete Error:", error);
            return res.status(500).json(ApiResponse.error(error.message));
        }
    }
}

export const mobileClinicalNoteController = new MobileClinicalNoteController();
