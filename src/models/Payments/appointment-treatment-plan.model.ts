import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, Relation, CreateDateColumn } from "typeorm/index.js";
import { Appointment } from "../Appointments/appointment.model.js";
import { TreatmentPlan } from "./treatment-plan.model.js";

@Entity({ name: "AppointmentTreatmentPlans" })
export class AppointmentTreatmentPlan {
    @PrimaryColumn("uniqueidentifier")
    AppointmentTreatmentPlanId: string;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "uniqueidentifier" })
    TreatmentPlanId: string;

    @ManyToOne(() => TreatmentPlan)
    @JoinColumn({ name: "TreatmentPlanId" })
    TreatmentPlan?: Relation<TreatmentPlan>;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;
}
