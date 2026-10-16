import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { PatientDietPlan } from "./patient-diet-plan.model.js";
import { DietFoodItem } from "./diet-food-item.model.js";

@Entity({ name: "PatientDietPlanMeals" })
export class PatientDietPlanMeal {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    PlanId: number;

    @ManyToOne(() => PatientDietPlan, (plan) => plan.Meals, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PlanId" })
    Plan?: Relation<PatientDietPlan>;

    @Column({ type: "int", default: 1 })
    DayNumber: number;                  // 1-7

    @Column({ type: "nvarchar", length: 50 })
    MealSlot: string;                   // "Early Morning" | "Breakfast" | "Mid-Morning" | "Lunch" | "Evening Snack" | "Dinner" | "Bedtime"

    @Column({ type: "nvarchar", length: 20 })
    MealTime: string;                   // "08:00 AM"

    @Column({ type: "int", nullable: true })
    FoodItemId?: number;                // FK to DietFoodItem (if from master database)

    @ManyToOne(() => DietFoodItem, { nullable: true })
    @JoinColumn({ name: "FoodItemId" })
    FoodItem?: Relation<DietFoodItem>;

    @Column({ type: "nvarchar", length: 200 })
    FoodName: string;                   // English name

    @Column({ type: "float", default: 1 })
    Quantity: number;

    @Column({ type: "nvarchar", length: 50, default: "'serving'" })
    Unit: string;                       // "katori", "piece", "cup", "glass", "tbsp", "serving"

    @Column({ type: "float", nullable: true })
    WeightAmount?: number;              // weight of the whole portion, e.g. 80

    @Column({ type: "nvarchar", length: 10, nullable: true })
    WeightUnit?: string;                // "g" or "ml"

    @Column({ type: "float", default: 0 })
    Calories: number;

    @Column({ type: "float", nullable: true })
    ProteinG?: number;

    @Column({ type: "float", nullable: true })
    CarbsG?: number;

    @Column({ type: "float", nullable: true })
    FatG?: number;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Notes?: string;                     // e.g. "Cook in cold-pressed mustard oil"

    @Column({ type: "int", default: 0 })
    SortOrder: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
