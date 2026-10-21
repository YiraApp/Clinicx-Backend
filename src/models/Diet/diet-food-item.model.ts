import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Organization } from "../Organizations/organization.model.js";

@Entity({ name: "DietFoodItems" })
export class DietFoodItem {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: 200 })
    Name: string;                       // English name: e.g., "Idli (2 pieces)", "Oats Porridge"

    @Column({ type: "nvarchar", length: 100 })
    Category: string;                   // "Breakfast" | "Grain" | "Protein" | "Vegetable" | "Fruit" | "Dairy" | "Beverage" | "Snack" | "Other"

    @Column({ type: "nvarchar", length: 50 })
    FoodType: string;                   // "Veg" | "Non-Veg" | "Vegan" | "Egg"

    @Column({ type: "nvarchar", length: 100, nullable: true })
    ServingSize?: string;               // e.g. "2 pieces (80g)" | "1 katori (150ml)"

    @Column({ type: "float", default: 0 })
    CaloriesPer100g: number;

    @Column({ type: "float", default: 0 })
    CaloriesPerServing: number;

    @Column({ type: "float", default: 0 })
    ProteinG: number;

    @Column({ type: "float", default: 0 })
    CarbsG: number;

    @Column({ type: "float", default: 0 })
    FatG: number;

    @Column({ type: "float", default: 0 })
    FiberG: number;

    @Column({ type: "float", nullable: true })
    SugarG?: number;

    @Column({ type: "float", nullable: true })
    SodiumMg?: number;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    ImageUrl?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Tags?: string;                      // JSON string: ["high-protein", "low-gi"]

    @Column({ type: "bit", default: 1 })
    IsActive: boolean;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;     // null = global platform item, number = org-specific custom item

    @ManyToOne(() => Organization, { nullable: true })
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Relation<Organization>;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
