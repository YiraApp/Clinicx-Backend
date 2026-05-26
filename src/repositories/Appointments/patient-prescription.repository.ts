import { AppDataSource } from "../../config/database.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { PrescriptionDiagnosis } from "../../models/Appointments/prescription-diagnosis.model.js";
import { PrescriptionMedication } from "../../models/Appointments/prescription-medication.model.js";

export class PatientPrescriptionRepository {
    private repo = AppDataSource.getRepository(PatientPrescription);

    async create(data: Partial<PatientPrescription>): Promise<PatientPrescription> {
        const record = this.repo.create(data);
        return await this.repo.save(record);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: string): Promise<PatientPrescription[]> {
        const where: any = { PatientId: patientId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;
        if (appointmentId) where.AppointmentId = appointmentId;

        return await this.repo.find({
            where,
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days"],
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: string): Promise<PatientPrescription | null> {
        return await this.repo.findOne({
            where: { Id: id }
        });
    }

    async findByAppointment(appointmentId: string, orgId?: number, hospitalId?: number): Promise<PatientPrescription[]> {
        const where: any = { AppointmentId: appointmentId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;

        return await this.repo.find({
            where,
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days"],
            order: { CreatedAt: "DESC" }
        });
    }

    async update(id: string, data: Partial<PatientPrescription>): Promise<void> {
        const existing = await this.repo.findOne({
            where: { Id: id },
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days"]
        });

        if (!existing) {
            throw new Error("Prescription not found");
        }

        // Normalize and dedupe incoming Diagnoses to avoid duplicate rows
        if (data.Diagnoses && Array.isArray(data.Diagnoses)) {
            const seenDiag = new Set<string>();
            const uniqueDiags: any[] = [];
            for (const d of data.Diagnoses) {
                const diagText = (d.Diagnosis || d.diagnosis || "").toString().trim().toLowerCase();
                const diagConcept = (d.DiagnosisConceptId || d.diagnosisConceptId || "").toString().trim();
                const key = `${diagText}|${diagConcept}`;
                if (!seenDiag.has(key)) {
                    seenDiag.add(key);
                    uniqueDiags.push(d);
                }
            }
            data.Diagnoses = uniqueDiags as any;
        }

        // Normalize and dedupe incoming Medications to avoid duplicate rows
        if (data.Medications && Array.isArray(data.Medications)) {
            const seenMed = new Set<string>();
            const uniqueMeds: any[] = [];
            for (const m of data.Medications) {
                const medName = (m.Medication || m.medication || "").toString().trim().toLowerCase();
                const dosage = (m.Dosage || m.dosage || "").toString().trim().toLowerCase();
                const freq = (m.FrequencyType || m.frequencyType || m.Frequency || m.frequency || "").toString().trim().toLowerCase();
                const dur = (m.DurationUnit || m.durationUnit || m.Duration || m.duration || "").toString().trim().toLowerCase();
                const route = (m.Route || m.route || "").toString().trim().toLowerCase();
                const instr = (m.Instructions || m.instructions || "").toString().trim().toLowerCase();
                const key = [medName, dosage, freq, dur, route, instr].join("|");
                if (!seenMed.has(key)) {
                    seenMed.add(key);
                    uniqueMeds.push(m);
                }
            }
            data.Medications = uniqueMeds as any;
        }

        // Differential update for Diagnoses: delete only removed, insert only new
        if (data.Diagnoses) {
            const diagRepo = AppDataSource.getRepository(PrescriptionDiagnosis);

            // build key -> existing Ids array (to detect duplicates)
            const existingDiags = existing.Diagnoses || [];
            const existingMap = new Map<string, { Id: string; CreatedAt?: Date }[]>();
            for (const ed of existingDiags) {
                const key = `${(ed.Diagnosis || "").toString().trim().toLowerCase()}|${(ed.DiagnosisConceptId || "").toString().trim()}`;
                const arr = existingMap.get(key) || [];
                arr.push({ Id: ed.Id, CreatedAt: (ed as any).CreatedAt });
                existingMap.set(key, arr);
            }

            // collapse duplicates in existing: keep earliest CreatedAt, delete extras
            for (const [key, arr] of existingMap.entries()) {
                if (arr.length > 1) {
                    arr.sort((a, b) => {
                        const ta = a.CreatedAt ? new Date(a.CreatedAt).getTime() : 0;
                        const tb = b.CreatedAt ? new Date(b.CreatedAt).getTime() : 0;
                        return ta - tb;
                    });
                    // keep first, delete others
                    const toDelete = arr.slice(1).map(x => x.Id);
                    for (const delId of toDelete) {
                        await diagRepo.delete(delId);
                    }
                    // shrink array to single kept id
                    existingMap.set(key, [arr[0]]);
                }
            }

            const incomingKeys = new Set<string>();
            for (const d of data.Diagnoses) {
                const key = `${(d.Diagnosis || d.diagnosis || "").toString().trim().toLowerCase()}|${(d.DiagnosisConceptId || d.diagnosisConceptId || "").toString().trim()}`;
                incomingKeys.add(key);
                if (!existingMap.has(key)) {
                    // insert new diagnosis
                    await diagRepo.save(diagRepo.create({ PrescriptionId: id, Diagnosis: d.Diagnosis || d.diagnosis, DiagnosisConceptId: d.DiagnosisConceptId || d.diagnosisConceptId }));
                }
            }

            // Diagnostic logs to help trace why deletes may not match
            try {
                console.info("[prescription.update] PrescriptionId", id, "existingDiagKeys:", Array.from(existingMap.keys()));
                console.info("[prescription.update] incomingDiagKeys:", Array.from(incomingKeys));
            } catch (err) {
                // ignore logging errors
            }

            // delete existing diagnoses that are not in incomingKeys
            for (const [key, arr] of existingMap.entries()) {
                if (!incomingKeys.has(key)) {
                    for (const ex of arr) {
                        await diagRepo.delete(ex.Id);
                    }
                }
            }
        }

        // Differential update for Medications: delete only removed, insert only new
        if (data.Medications) {
            const medRepo = AppDataSource.getRepository(PrescriptionMedication);

            const existingMeds = existing.Medications || [];
            const existingMedMap = new Map<string, { Id: string; CreatedAt?: Date }[]>();
            for (const em of existingMeds) {
                const key = [
                    (em.Medication || "").toString().trim().toLowerCase(),
                    (em.Dosage || "").toString().trim().toLowerCase(),
                    (em.FrequencyType || "").toString().trim().toLowerCase(),
                    (em.DurationUnit || "").toString().trim().toLowerCase(),
                    (em.Route || "").toString().trim().toLowerCase(),
                    (em.Instructions || "").toString().trim().toLowerCase()
                ].join("|");
                const arr = existingMedMap.get(key) || [];
                arr.push({ Id: em.Id, CreatedAt: (em as any).CreatedAt });
                existingMedMap.set(key, arr);
            }

            // collapse duplicates in existing meds: keep earliest, delete others
            for (const [key, arr] of existingMedMap.entries()) {
                if (arr.length > 1) {
                    arr.sort((a, b) => {
                        const ta = a.CreatedAt ? new Date(a.CreatedAt).getTime() : 0;
                        const tb = b.CreatedAt ? new Date(b.CreatedAt).getTime() : 0;
                        return ta - tb;
                    });
                    const toDelete = arr.slice(1).map(x => x.Id);
                    for (const delId of toDelete) {
                        await medRepo.delete(delId);
                    }
                    existingMedMap.set(key, [arr[0]]);
                }
            }

            const incomingMedKeys = new Set<string>();
            for (const m of data.Medications) {
                const key = [
                    (m.Medication || m.medication || "").toString().trim().toLowerCase(),
                    (m.Dosage || m.dosage || "").toString().trim().toLowerCase(),
                    (m.FrequencyType || m.frequencyType || m.Frequency || m.frequency || "").toString().trim().toLowerCase(),
                    (m.DurationUnit || m.durationUnit || m.Duration || m.duration || "").toString().trim().toLowerCase(),
                    (m.Route || m.route || "").toString().trim().toLowerCase(),
                    (m.Instructions || m.instructions || "").toString().trim().toLowerCase()
                ].join("|");
                incomingMedKeys.add(key);
                if (!existingMedMap.has(key)) {
                    // insert new medication (schedules/days ignored for now)
                    await medRepo.save(medRepo.create({
                        PrescriptionId: id,
                        Medication: m.Medication || m.medication,
                        ConceptId: m.ConceptId || m.conceptId,
                        Dosage: m.Dosage || m.dosage,
                        DurationValue: m.DurationValue || m.durationValue,
                        DurationUnit: m.DurationUnit || m.durationUnit || m.Duration || m.duration,
                        FrequencyType: m.FrequencyType || m.frequencyType || m.Frequency || m.frequency,
                        Instructions: m.Instructions || m.instructions,
                        Route: m.Route || m.route
                    }));
                }
            }

            // Diagnostic logs for medications
            try {
                console.info("[prescription.update] PrescriptionId", id, "existingMedKeys:", Array.from(existingMedMap.keys()));
                console.info("[prescription.update] incomingMedKeys:", Array.from(incomingMedKeys));
            } catch (err) {
                // ignore logging errors
            }

            // delete existing meds not in incoming
            for (const [key, arr] of existingMedMap.entries()) {
                if (!incomingMedKeys.has(key)) {
                    for (const ex of arr) {
                        await medRepo.delete(ex.Id);
                    }
                }
            }
        }

        // clear collections to prevent cascade re-saving (already handled manually above)
        existing.Diagnoses = undefined as any;
        existing.Medications = undefined as any;

        // merge and save header fields only
        const { Diagnoses, Medications, ...headerData } = data;
        const merged = this.repo.merge(existing, {
            ...headerData,
            UpdatedAt: new Date()
        });

        await this.repo.save(merged);
    }

    async delete(id: string): Promise<void> {
        await this.repo.delete(id);
    }
}

export const patientPrescriptionRepository = new PatientPrescriptionRepository();
