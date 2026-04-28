import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "PatientQueue" })
export class PatientQueue {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment: Relation<Appointment>;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor: Relation<User>;

    @Column({ type: "int", nullable: true })
    QueueNumber?: number;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Status?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    AddedAt: Date;

    @Column({ type: "datetime", nullable: true })
    CalledAt?: Date;

    @Column({ type: "datetime", nullable: true })
    CompletedAt?: Date;
}
