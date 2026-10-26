import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A hospital stay written up at discharge: what ABDM shares as a DischargeSummary.
 * The coded lists are JSON arrays of { text, conceptId? }, conceptId a SNOMED CT concept.
 * Only a Final summary is shared.
 */
@Entity({ name: "DischargeSummaries" })
export class DischargeSummary {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    /** The doctor who wrote it (Users.Id). */
    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @Column({ type: "datetime" })
    AdmittedAt: Date;

    @Column({ type: "datetime" })
    DischargedAt: Date;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ChiefComplaints?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Diagnoses?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    MedicalHistory?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ExaminationFindings?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Procedures?: string | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Allergies?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Investigations?: string | null;

    /** The discharge medicines, as a prescription (PatientPrescription.Id). */
    @Column({ type: "uniqueidentifier", nullable: true })
    PrescriptionId?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    CarePlan?: string | null;

    @Column({ type: "datetime", nullable: true })
    FollowUpDate?: Date | null;

    /** Where the patient went, such as "Discharged home". */
    @Column({ type: "nvarchar", length: 200, nullable: true })
    Disposition?: string | null;

    /** The signed summary, uploaded (MedicalDocuments.Id). */
    @Column({ type: "int", nullable: true })
    DocumentId?: number | null;

    /** Draft or Final. */
    @Column({ type: "varchar", length: 20, default: "Draft" })
    Status: string;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string | null;
}
