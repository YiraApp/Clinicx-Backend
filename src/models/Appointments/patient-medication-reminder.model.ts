import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "PatientMedicationReminders" })
export class PatientMedicationReminder {
    @PrimaryColumn({ type: "varchar", length: 100 })
    Id: string;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    PrescriptionId?: string | null;

    @Column({ type: "nvarchar", length: 255 })
    MedicineName: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Dosage?: string | null;

    @Column({ type: "nvarchar", length: "max", nullable: true })
    Instructions?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    MealRelation?: string | null;

    @Column({ type: "nvarchar", length: "max" })
    TimesJson: string; // JSON array e.g. '["08:00 AM", "08:00 PM"]'

    @Column({ type: "date" })
    StartDate: string | Date;

    @Column({ type: "date" })
    EndDate: string | Date;

    @Column({ type: "int", default: 1 })
    DurationDays: number;

    @Column({ type: "bit", default: 0 })
    IsContinuous: boolean;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    DoctorName?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    DoctorPhoto?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Condition?: string | null;

    @Column({ type: "bit", default: 1 })
    IsActive: boolean;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;

    @UpdateDateColumn({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
