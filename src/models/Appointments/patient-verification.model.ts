import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { Appointment } from "./appointment.model.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "PatientVerifications" })
export class PatientVerification {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    AppointmentId: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId" })
    Appointment: Relation<Appointment>;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    CheckInStatus?: string;

    @Column({ type: "bit", default: 0 })
    IsIdVerified: boolean;

    @Column({ type: "bit", default: 0 })
    IsDocumentVerified: boolean;

    @Column({ type: "bit", default: 0 })
    IsInsuranceVerified: boolean;

    @Column({ type: "uniqueidentifier", nullable: true })
    VerifiedBy?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "VerifiedBy" })
    Verifier?: Relation<User>;

    @Column({ type: "datetime", nullable: true })
    VerifiedAt?: Date;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Notes?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
