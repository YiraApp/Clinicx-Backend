import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "PatientPrescription" })
export class PatientPrescription {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "nvarchar", length: 255, nullable: true, default: "0" })
    AppointmentId?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    MedicalRecordId?: string;

    @Column({ type: "nvarchar", length: 255 })
    PatientId: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    DoctorId?: string;

    @Column({ type: "nvarchar", length: 255 })
    Medication: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    ConceptId?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Dosage?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Frequency?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Duration?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Route?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Diagnosis?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    DiagnosisConceptId?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Instructions?: string;

    @Column({ type: "datetime", nullable: true, default: () => "GETDATE()" })
    Date?: Date;

    @Column({ type: "datetime", nullable: true, default: () => "GETDATE()" })
    CreatedAt?: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    CreatedBy?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;
}
