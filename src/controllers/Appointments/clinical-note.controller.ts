import { Request, Response } from "express";
import { clinicalNoteService } from "../../services/Appointments/clinical-note.service.js";
import { ApiResponse } from "../../utils/response.utils.js";

export class ClinicalNoteController {
    async create(req: Request, res: Response) {
        try {
            const result = await clinicalNoteService.addNote(req.body);
            return res.status(201).json(ApiResponse.success(result, "Clinical note added successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getPatientNotes(req: Request, res: Response) {
        try {
            const { patientId } = req.params;
            const { orgId, hospitalId, appointmentId } = req.query;
            
            const parsedOrgId = orgId ? parseInt(String(orgId)) : undefined;
            const parsedHospitalId = hospitalId ? parseInt(String(hospitalId)) : undefined;
            const parsedAppointmentId = appointmentId ? parseInt(String(appointmentId)) : undefined;
            
            const result = await clinicalNoteService.getPatientNotes(
                patientId as string, 
                isNaN(parsedOrgId as any) ? undefined : parsedOrgId, 
                isNaN(parsedHospitalId as any) ? undefined : parsedHospitalId,
                isNaN(parsedAppointmentId as any) ? undefined : parsedAppointmentId
            );
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async getAppointmentNotes(req: Request, res: Response) {
        try {
            const { appointmentId } = req.params;
            const result = await clinicalNoteService.getAppointmentNotes(parseInt(appointmentId as string));
            return res.json(ApiResponse.success(result));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const { notes, updatedBy } = req.body;
            await clinicalNoteService.updateNote(parseInt(id as string), notes, updatedBy);
            return res.json(ApiResponse.success(null, "Clinical note updated successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const { id } = req.params;
            await clinicalNoteService.deleteNote(parseInt(id as string));
            return res.json(ApiResponse.success(null, "Clinical note deleted successfully."));
        } catch (error: any) {
            return res.status(400).json(ApiResponse.error(error.message));
        }
    }
}

export const clinicalNoteController = new ClinicalNoteController();
