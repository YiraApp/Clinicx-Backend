import { AppDataSource } from "../../config/database.js";
import { PatientImmunization } from "../../models/Appointments/patient-immunization.model.js";

/** Vaccines given at the clinic, which ABDM shares as an ImmunizationRecord. */

export interface ImmunizationInput {
    patientId: string;
    hospitalId: number;
    organizationId?: number | null;
    appointmentId?: number | null;
    doctorId?: string | null;
    vaccineName: string;
    vaccineConceptId?: string | null;
    doseNumber?: number | null;
    administeredOn: string;
    lotNumber?: string | null;
    manufacturer?: string | null;
    route?: string | null;
    site?: string | null;
    nextDueDate?: string | null;
    notes?: string | null;
    certificateDocumentId?: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown, max: number): string | null => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    const s = String(value).trim();
    if (s.length > max) throw new Error(`A value is longer than ${max} characters.`);
    return s;
};
const positiveInt = (value: unknown, name: string): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of 1 or more.`);
    return n;
};
const date = (value: unknown, name: string, required: boolean): string | null => {
    if (value === undefined || value === null || value === "") {
        if (required) throw new Error(`${name} is required (YYYY-MM-DD).`);
        return null;
    }
    if (!DATE.test(String(value))) throw new Error(`${name} must be a date as YYYY-MM-DD.`);
    return String(value);
};

/** The columns an input sets, checked. [partial] skips what an update leaves out. */
export const immunizationColumns = (input: Partial<ImmunizationInput>, partial = false): Partial<PatientImmunization> => {
    const cols: Partial<PatientImmunization> = {};
    const has = (key: keyof ImmunizationInput) => !partial || key in input;
    if (!partial) {
        if (!input.patientId) throw new Error("patientId is required.");
        if (!positiveInt(input.hospitalId, "hospitalId")) throw new Error("hospitalId is required.");
        cols.PatientId = input.patientId;
        cols.HospitalId = Number(input.hospitalId);
        cols.OrganizationId = positiveInt(input.organizationId, "organizationId");
        cols.AppointmentId = positiveInt(input.appointmentId, "appointmentId");
    }
    if (has("vaccineName")) {
        const name = text(input.vaccineName, 200);
        if (!name) throw new Error("vaccineName is required.");
        cols.VaccineName = name;
    }
    if (has("vaccineConceptId")) {
        const id = text(input.vaccineConceptId, 30);
        if (id && !/^\d{6,18}$/.test(id)) throw new Error("vaccineConceptId must be a SNOMED CT concept id.");
        cols.VaccineConceptId = id;
    }
    if (has("doctorId")) cols.DoctorId = text(input.doctorId, 36);
    if (has("doseNumber")) cols.DoseNumber = positiveInt(input.doseNumber, "doseNumber");
    if (has("administeredOn")) cols.AdministeredOn = date(input.administeredOn, "administeredOn", true)!;
    if (has("lotNumber")) cols.LotNumber = text(input.lotNumber, 50);
    if (has("manufacturer")) cols.Manufacturer = text(input.manufacturer, 200);
    if (has("route")) cols.Route = text(input.route, 50);
    if (has("site")) cols.Site = text(input.site, 50);
    if (has("nextDueDate")) cols.NextDueDate = date(input.nextDueDate, "nextDueDate", false);
    if (has("notes")) cols.Notes = text(input.notes, 1000);
    if (has("certificateDocumentId")) cols.CertificateDocumentId = positiveInt(input.certificateDocumentId, "certificateDocumentId");
    if (cols.NextDueDate && cols.AdministeredOn && cols.NextDueDate < cols.AdministeredOn) {
        throw new Error("nextDueDate can't be before administeredOn.");
    }
    return cols;
};

export class ImmunizationService {
    private get repository() {
        return AppDataSource.getRepository(PatientImmunization);
    }

    async create(input: ImmunizationInput, createdBy?: string): Promise<PatientImmunization> {
        return this.repository.save(this.repository.create({ ...immunizationColumns(input), CreatedBy: createdBy ?? null }));
    }

    async listForPatient(patientId: string, hospitalId?: number): Promise<PatientImmunization[]> {
        return this.repository.find({
            where: { PatientId: patientId, IsDeleted: false, ...(hospitalId ? { HospitalId: hospitalId } : {}) },
            order: { AdministeredOn: "DESC", Id: "DESC" },
        });
    }

    async update(id: number, input: Partial<ImmunizationInput>, updatedBy?: string): Promise<PatientImmunization> {
        const existing = await this.repository.findOne({ where: { Id: id, IsDeleted: false } });
        if (!existing) throw new Error("Immunization not found.");
        const cols = immunizationColumns(input, true);
        const next = { ...existing, ...cols };
        if (next.NextDueDate && next.NextDueDate < next.AdministeredOn) throw new Error("nextDueDate can't be before administeredOn.");
        // The row's own patient, hospital and visit ride along so the ABDM auto-linker sees whose record changed
        await this.repository.update(id, { PatientId: existing.PatientId, HospitalId: existing.HospitalId, AppointmentId: existing.AppointmentId ?? null, ...cols, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
        return (await this.repository.findOne({ where: { Id: id } }))!;
    }

    async delete(id: number, updatedBy?: string): Promise<void> {
        await this.repository.update(id, { IsDeleted: true, UpdatedAt: new Date(), UpdatedBy: updatedBy ?? null });
    }
}

export const immunizationService = new ImmunizationService();
