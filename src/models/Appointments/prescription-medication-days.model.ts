import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { PrescriptionMedication } from "./prescription-medication.model.js";

@Entity({ name: "PrescriptionMedicationDays" })
export class PrescriptionMedicationDays {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    PrescriptionMedicationId: string;

    @ManyToOne(() => PrescriptionMedication, (medication) => medication.Days, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PrescriptionMedicationId" })
    Medication?: Relation<PrescriptionMedication>;

    @Column({ type: "int" })
    DayOfWeek: number;

    @Column({ type: "datetime", default: () => "GETUTCDATE()" })
    CreatedAt: Date;
}
