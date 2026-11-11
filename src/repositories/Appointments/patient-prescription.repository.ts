import { AppDataSource } from "../../config/database.js";
import { PatientPrescription } from "../../models/Appointments/patient-prescription.model.js";
import { PrescriptionDiagnosis } from "../../models/Appointments/prescription-diagnosis.model.js";
import { PrescriptionMedication } from "../../models/Appointments/prescription-medication.model.js";
import { planMedicationChanges } from "../../utils/prescription-medications.js";
import { PrescriptionLabTest } from "../../models/Appointments/prescription-lab-test.model.js";

export class PatientPrescriptionRepository {
    private repo = AppDataSource.getRepository(PatientPrescription);

    async create(data: Partial<PatientPrescription>): Promise<PatientPrescription> {
        // Set here, not by the column's GETDATE() default: Azure SQL's clock is UTC while the app
        // stores India time, so the default put prescriptions (and their "Issued" time) 5.5 hours early.
        const record = this.repo.create({ ...data, CreatedAt: data.CreatedAt ?? new Date() });
        return await this.repo.save(record);
    }

    async findByPatient(patientId: string, orgId?: number, hospitalId?: number, appointmentId?: string): Promise<PatientPrescription[]> {
        const where: any = { PatientId: patientId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;
        if (appointmentId) where.AppointmentId = appointmentId;

        return await this.repo.find({
            where,
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days", "Doctor", "LabTests"],
            order: { CreatedAt: "DESC" }
        });
    }

    async findById(id: string): Promise<PatientPrescription | null> {
        return await this.repo.findOne({
            where: { Id: id },
            relations: ["Doctor"]
        });
    }

    async findByAppointment(appointmentId: string, orgId?: number, hospitalId?: number): Promise<PatientPrescription[]> {
        const where: any = { AppointmentId: appointmentId };
        if (orgId) where.OrganizationId = orgId;
        if (hospitalId) where.HospitalId = hospitalId;

        return await this.repo.find({
            where,
            relations: ["Diagnoses", "Medications", "Medications.Schedules", "Medications.Days", "Doctor", "LabTests"],
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
                const dd = d as any;
                const diagText = (dd.Diagnosis || dd.diagnosis || "").toString().trim().toLowerCase();
                const diagConcept = (dd.DiagnosisConceptId || dd.diagnosisConceptId || "").toString().trim();
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
                const mm = m as any;
                const medName = (mm.Medication || mm.medication || "").toString().trim().toLowerCase();
                const dosage = (mm.Dosage || mm.dosage || "").toString().trim().toLowerCase();
                const freq = (mm.FrequencyType || mm.frequencyType || mm.Frequency || mm.frequency || "").toString().trim().toLowerCase();
                const dur = (mm.DurationUnit || mm.durationUnit || mm.Duration || mm.duration || "").toString().trim().toLowerCase();
                const route = (mm.Route || mm.route || "").toString().trim().toLowerCase();
                const instr = (mm.Instructions || mm.instructions || "").toString().trim().toLowerCase();
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
                const dd = d as any;
                const key = `${(dd.Diagnosis || dd.diagnosis || "").toString().trim().toLowerCase()}|${(dd.DiagnosisConceptId || dd.diagnosisConceptId || "").toString().trim()}`;
                incomingKeys.add(key);
                if (!existingMap.has(key)) {
                    // insert new diagnosis
                    await diagRepo.save(diagRepo.create({ PrescriptionId: id, Diagnosis: dd.Diagnosis || dd.diagnosis, DiagnosisConceptId: dd.DiagnosisConceptId || dd.diagnosisConceptId }));
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

        // Medications: lines that stay keep their row and get their new place, new lines are
        // inserted at theirs, and lines that were removed (or duplicated) are deleted.
        if (data.Medications) {
            const medRepo = AppDataSource.getRepository(PrescriptionMedication);
            const plan = planMedicationChanges(existing.Medications || [], data.Medications as any[]);
            for (const delId of plan.remove) {
                await medRepo.delete(delId);
            }
            for (const { id: keepId, sortOrder } of plan.keep) {
                await medRepo.update(keepId, { SortOrder: sortOrder });
            }
            for (const { medication, sortOrder } of plan.insert) {
                const mm = medication as any;
                await medRepo.save(medRepo.create({
                    PrescriptionId: id,
                    Medication: mm.Medication || mm.medication,
                    ConceptId: mm.ConceptId || mm.conceptId,
                    Dosage: mm.Dosage || mm.dosage,
                    DurationValue: mm.DurationValue || mm.durationValue,
                    DurationUnit: mm.DurationUnit || mm.durationUnit || mm.Duration || mm.duration,
                    FrequencyType: mm.FrequencyType || mm.frequencyType || mm.Frequency || mm.frequency,
                    Instructions: mm.Instructions || mm.instructions,
                    Route: mm.Route || mm.route,
                    SortOrder: sortOrder
                }));
            }
            console.info("[prescription.update]", id, `medicines kept ${plan.keep.length}, added ${plan.insert.length}, removed ${plan.remove.length}`);
        }

        // Replaced only when sent: older app versions do not send lab tests.
        if (Array.isArray(data.LabTests)) {
            const labRepo = AppDataSource.getRepository(PrescriptionLabTest);
            await labRepo.delete({ PrescriptionId: id } as any);
            if (data.LabTests.length > 0) {
                await labRepo.save(data.LabTests.map((test) => labRepo.create({ ...test, PrescriptionId: id })));
            }
        }

        // clear collections to prevent cascade re-saving (already handled manually above)
        existing.Diagnoses = undefined as any;
        existing.Medications = undefined as any;

        // merge and save header fields only
        const { Diagnoses, Medications, LabTests, ...headerData } = data;
        const merged = this.repo.merge(existing, {
            ...headerData,
            UpdatedAt: new Date()
        });

        await this.repo.save(merged);
    }

    async delete(id: string): Promise<void> {
        try {
            await AppDataSource.getRepository(PrescriptionDiagnosis).delete({ PrescriptionId: id } as any);
            await AppDataSource.getRepository(PrescriptionLabTest).delete({ PrescriptionId: id } as any);
            await AppDataSource.getRepository(PrescriptionMedication).delete({ PrescriptionId: id } as any);
        } catch (e) {
            console.error("[patientPrescriptionRepository.delete] Error cleaning child records:", e);
        }
        await this.repo.delete(id);
    }
}

export const patientPrescriptionRepository = new PatientPrescriptionRepository();
