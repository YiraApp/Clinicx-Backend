import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany, Relation } from "typeorm/index.js";
import type { HealthcareProvider } from "./healthcare-provider.model.js";
import { Organization } from "./organization.model.js";
import { Hospital } from "./hospital.model.js";
import { Appointment } from "../Appointments/appointment.model.js";

@Entity({ name: "HealthcareProviderScheduleSlots" })
export class HealthcareProviderScheduleSlot {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    ProviderId: number;

    @ManyToOne("HealthcareProvider")
    @JoinColumn({ name: "ProviderId" })
    Provider: Relation<HealthcareProvider>;

    @Column({ type: "int" })
    OrganizationId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization: Organization;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "date" })
    SlotDate: Date;

    @Column({ type: "nvarchar", length: 10 })
    StartTime: string;

    @Column({ type: "nvarchar", length: 10 })
    EndTime: string;

    @Column({ type: "bit", default: 1 })
    IsAvailable: boolean; // 1 = Available for booking, 0 = Blocked/Offline

    @Column({ type: "bit", default: 0 })
    IsBooked: boolean;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Status: string; // e.g., 'Available', 'Booked', 'Blocked', 'Break'

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @OneToMany(() => Appointment, (a) => a.Slot)
    Appointments: Appointment[];
}
