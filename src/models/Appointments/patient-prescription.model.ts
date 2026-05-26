import { Entity, PrimaryGeneratedColumn, Column, OneToMany, Relation } from "typeorm/index.js";
import { PrescriptionDiagnosis } from "./prescription-diagnosis.model.js";
import { PrescriptionMedication } from "./prescription-medication.model.js";

@Entity({ name: "PatientPrescription" })
export class PatientPrescription {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "nvarchar", length: 255, nullable: true, default: null })
    AppointmentId?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    MedicalRecordId?: string;

    @Column({ type: "nvarchar", length: 255 })
    PatientId: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    DoctorId?: string;

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

    @Column({ type: "nvarchar", length: 4000, nullable: true })
    Notes?: string | null;

    @OneToMany(() => PrescriptionDiagnosis, (diagnosis) => diagnosis.Prescription, { cascade: true })
    Diagnoses?: Relation<PrescriptionDiagnosis[]>;

    @OneToMany(() => PrescriptionMedication, (medication) => medication.Prescription, { cascade: true })
    Medications?: Relation<PrescriptionMedication[]>;
}
