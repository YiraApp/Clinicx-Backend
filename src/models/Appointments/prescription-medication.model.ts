import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Relation } from "typeorm/index.js";
import { PatientPrescription } from "./patient-prescription.model.js";
import { PrescriptionMedicationSchedule } from "./prescription-medication-schedule.model.js";
import { PrescriptionMedicationDays } from "./prescription-medication-days.model.js";

@Entity({ name: "PrescriptionMedication" })
export class PrescriptionMedication {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    PrescriptionId: string;

    @ManyToOne(() => PatientPrescription, (prescription) => prescription.Medications, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PrescriptionId" })
    Prescription?: Relation<PatientPrescription>;

    @Column({ type: "nvarchar", length: 500 })
    Medication: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    ConceptId?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Dosage?: string;

    @Column({ type: "int", nullable: true })
    DurationValue?: number;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    DurationUnit?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    FrequencyType?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Instructions?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Route?: string;

    @Column({ type: "datetime", default: () => "GETUTCDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    UpdatedBy?: string;

    @OneToMany(() => PrescriptionMedicationSchedule, (schedule) => schedule.Medication, { cascade: true })
    Schedules?: Relation<PrescriptionMedicationSchedule[]>;

    @OneToMany(() => PrescriptionMedicationDays, (day) => day.Medication, { cascade: true })
    Days?: Relation<PrescriptionMedicationDays[]>;
}
