import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Relation } from "typeorm/index.js";
import { Organization } from "../Organizations/organization.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { User } from "../Account/user.model.js";
import { DietTemplateMeal } from "./diet-template-meal.model.js";

@Entity({ name: "DietTemplates" })
export class DietTemplate {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: 200 })
    Name: string;                       // e.g. "Type 2 Diabetes - Vegetarian"

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Description?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Condition?: string;                 // "Diabetes" | "Hypertension" | "PCOD" | "Weight Loss" | "General Wellness"

    @Column({ type: "int", default: 7 })
    TotalDays: number;                  // 1 (repeats daily) or 7 (weekly cycle)

    @Column({ type: "float", nullable: true })
    TargetCalories?: number;

    @Column({ type: "float", nullable: true })
    TargetProteinG?: number;

    @Column({ type: "float", nullable: true })
    TargetCarbsG?: number;

    @Column({ type: "float", nullable: true })
    TargetFatG?: number;

    @Column({ type: "nvarchar", length: 50, default: "'Veg'" })
    DietType: string;                   // "Veg" | "Non-Veg" | "Eggetarian" | "Vegan"

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    GeneralNotes?: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedByDoctorId?: string | null;  // null for system default starter templates

    @ManyToOne(() => User, { nullable: true })
    @JoinColumn({ name: "CreatedByDoctorId" })
    Doctor?: Relation<User>;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;     // null for system platform templates; mandatory for org templates

    @ManyToOne(() => Organization, { nullable: true })
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Relation<Organization>;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;                // Branch/Hospital within organization

    @ManyToOne(() => Hospital, { nullable: true })
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "bit", default: 0 })
    IsOrganizationShared: boolean;      // true = visible to all doctors in this organization

    @Column({ type: "bit", default: 0 })
    IsSystemDefault: boolean;           // true = built-in read-only starter template

    @Column({ type: "bit", default: 1 })
    IsActive: boolean;

    @OneToMany(() => DietTemplateMeal, (meal) => meal.Template, { cascade: true })
    Meals?: Relation<DietTemplateMeal[]>;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
