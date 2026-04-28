import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "Visits" })
export class Visit {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment: Relation<Appointment>;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: Relation<User>;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor: Relation<User>;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Status?: string;

    @Column({ type: "datetime", nullable: true })
    CheckInTime?: Date;

    @Column({ type: "datetime", nullable: true })
    ConsultationStart?: Date;

    @Column({ type: "datetime", nullable: true })
    ConsultationEnd?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
