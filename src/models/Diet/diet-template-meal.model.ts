import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { DietTemplate } from "./diet-template.model.js";
import { DietFoodItem } from "./diet-food-item.model.js";

@Entity({ name: "DietTemplateMeals" })
export class DietTemplateMeal {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    TemplateId: number;

    @ManyToOne(() => DietTemplate, (template) => template.Meals, { onDelete: "CASCADE" })
    @JoinColumn({ name: "TemplateId" })
    Template?: Relation<DietTemplate>;

    @Column({ type: "int", default: 1 })
    DayNumber: number;                  // 1-7

    @Column({ type: "nvarchar", length: 50 })
    MealSlot: string;                   // "Early Morning" | "Breakfast" | "Mid-Morning" | "Lunch" | "Evening Snack" | "Dinner" | "Bedtime"

    @Column({ type: "nvarchar", length: 20 })
    MealTime: string;                   // "08:00 AM"

    @Column({ type: "int", nullable: true })
    FoodItemId?: number;                // FK to DietFoodItem (if selected from master)

    @ManyToOne(() => DietFoodItem, { nullable: true })
    @JoinColumn({ name: "FoodItemId" })
    FoodItem?: Relation<DietFoodItem>;

    @Column({ type: "nvarchar", length: 200 })
    FoodName: string;                   // English name

    @Column({ type: "float", default: 1 })
    Quantity: number;

    @Column({ type: "nvarchar", length: 50, default: "'serving'" })
    Unit: string;                       // "katori", "piece", "cup", "glass", "tbsp", "serving"

    @Column({ type: "float", default: 0 })
    Calories: number;

    @Column({ type: "float", nullable: true })
    ProteinG?: number;

    @Column({ type: "float", nullable: true })
    CarbsG?: number;

    @Column({ type: "float", nullable: true })
    FatG?: number;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Notes?: string;

    @Column({ type: "int", default: 0 })
    SortOrder: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
