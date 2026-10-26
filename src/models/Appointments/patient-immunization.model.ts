import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/** A vaccine given to a patient: what ABDM shares as an ImmunizationRecord. */
@Entity({ name: "PatientImmunizations" })
export class PatientImmunization {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    /** The visit it was given at, when there was one. */
    @Column({ type: "int", nullable: true })
    AppointmentId?: number | null;

    /** The doctor who gave or recorded it (Users.Id). */
    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string | null;

    @Column({ type: "nvarchar", length: 200 })
    VaccineName: string;

    /** SNOMED CT concept picked for the vaccine, if any. */
    @Column({ type: "varchar", length: 30, nullable: true })
    VaccineConceptId?: string | null;

    @Column({ type: "int", nullable: true })
    DoseNumber?: number | null;

    @Column({ type: "date" })
    AdministeredOn: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    LotNumber?: string | null;

    @Column({ type: "nvarchar", length: 200, nullable: true })
    Manufacturer?: string | null;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Route?: string | null;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Site?: string | null;

    @Column({ type: "date", nullable: true })
    NextDueDate?: string | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Notes?: string | null;

    /** An uploaded certificate (MedicalDocuments.Id). */
    @Column({ type: "int", nullable: true })
    CertificateDocumentId?: number | null;

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
