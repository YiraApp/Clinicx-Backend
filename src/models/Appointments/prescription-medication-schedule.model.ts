import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { PrescriptionMedication } from "./prescription-medication.model.js";

@Entity({ name: "PrescriptionMedicationSchedule" })
export class PrescriptionMedicationSchedule {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    PrescriptionMedicationId: string;

    @ManyToOne(() => PrescriptionMedication, (medication) => medication.Schedules, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PrescriptionMedicationId" })
    Medication?: Relation<PrescriptionMedication>;

    @Column({ type: "nvarchar", length: 50 })
    TimeSlot: string;

    @Column({ type: "decimal", precision: 4, scale: 2 })
    Dose: number;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    MealTiming?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    MealType?: string;

    @Column({ type: "datetime", default: () => "GETUTCDATE()" })
    CreatedAt: Date;
}
