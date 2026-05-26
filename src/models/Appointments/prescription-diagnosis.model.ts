import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { PatientPrescription } from "./patient-prescription.model.js";

@Entity({ name: "PrescriptionDiagnosis" })
export class PrescriptionDiagnosis {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    PrescriptionId: string;

    @ManyToOne(() => PatientPrescription, (prescription) => prescription.Diagnoses, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PrescriptionId" })
    Prescription?: Relation<PatientPrescription>;

    @Column({ type: "nvarchar", length: 500 })
    Diagnosis: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    DiagnosisConceptId?: string;

    @Column({ type: "datetime", default: () => "GETUTCDATE()" })
    CreatedAt: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string;
}
