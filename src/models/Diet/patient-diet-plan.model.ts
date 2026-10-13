import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn, Relation } from "typeorm/index.js";
import { Organization } from "../Organizations/organization.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { User } from "../Account/user.model.js";
import { Appointment } from "../Appointments/appointment.model.js";
import { PatientDietPlanMeal } from "./patient-diet-plan-meal.model.js";

@Entity({ name: "PatientDietPlans" })
export class PatientDietPlan {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient?: Relation<User>;

    @Column({ type: "uniqueidentifier" })
    AssignedByDoctorId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "AssignedByDoctorId" })
    AssignedByDoctor?: Relation<User>;

    @Column({ type: "int" })
    OrganizationId: number;             // Mandatory: Prescribing organization

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Relation<Organization>;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;                // Clinic/Hospital branch within the org

    @ManyToOne(() => Hospital, { nullable: true })
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "int", nullable: true })
    SourceTemplateId?: number;          // FK to DietTemplate (if created from template)

    @Column({ type: "int", nullable: true })
    AppointmentId?: number;             // Link to consultation where diet was assigned

    @ManyToOne(() => Appointment, { nullable: true })
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "nvarchar", length: 200 })
    PlanName: string;                   // "Your Diabetes Diet Plan"

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Description?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Condition?: string;                 // "Type 2 Diabetes"

    @Column({ type: "int", default: 7 })
    TotalDays: number;                  // 1 (same daily) or 7 (weekly cycle)

    @Column({ type: "date" })
    StartDate: Date;

    @Column({ type: "date", nullable: true })
    EndDate?: Date;                     // null = ongoing until doctor changes

    @Column({ type: "float", nullable: true })
    TargetCalories?: number;

    @Column({ type: "float", nullable: true })
    TargetProteinG?: number;

    @Column({ type: "float", nullable: true })
    TargetCarbsG?: number;

    @Column({ type: "float", nullable: true })
    TargetFatG?: number;

    @Column({ type: "nvarchar", length: 50, default: "'Veg'" })
    DietType: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    DoctorNotes?: string;               // Clinical directions for the patient

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FoodsToAvoid?: string;              // JSON array string e.g. ["White Rice", "Maida", "Sugary Drinks"]

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FoodsToPrefer?: string;             // JSON array string e.g. ["Millets", "Green Veggies", "Nuts"]

    @Column({ type: "nvarchar", length: 20, default: "'active'" })
    Status: string;                     // "active" | "completed" | "paused" | "cancelled"

    @OneToMany(() => PatientDietPlanMeal, (meal) => meal.Plan, { cascade: true })
    Meals?: Relation<PatientDietPlanMeal[]>;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
