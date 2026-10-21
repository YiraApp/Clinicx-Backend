import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A patient's record of one prescribed food on one date: whether they ate it,
 * and an optional photo of what they ate.
 *
 * PlanMealId has no foreign key on purpose. Plan meals are replaced when a
 * plan is edited, and the patient's history must survive that, so the slot
 * and food name are kept here too.
 */
@Entity({ name: "PatientDietMealLogs" })
export class PatientDietMealLog {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    PlanId: number;

    @Column({ type: "int" })
    PlanMealId: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "date" })
    LogDate: string;                    // "YYYY-MM-DD", the patient's local date

    @Column({ type: "nvarchar", length: 50 })
    MealSlot: string;

    @Column({ type: "nvarchar", length: 200 })
    FoodName: string;

    @Column({ type: "bit", default: 0 })
    IsEaten: boolean;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    PhotoUrl?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
