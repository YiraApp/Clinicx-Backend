import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { HealthcareProvider } from "./healthcare-provider.model.js";

@Entity("HealthcareProviderAvailability")
export class HealthcareProviderAvailability {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    ProviderId: number;

    @ManyToOne(() => HealthcareProvider)
    @JoinColumn({ name: "ProviderId" })
    Provider: HealthcareProvider;

    @Column({ type: "nvarchar", length: 20 })
    DayOfWeek: string; // Monday, Tuesday, etc.

    @Column({ type: "nvarchar", length: 10 })
    StartTime: string; // 09:00

    @Column({ type: "nvarchar", length: 10 })
    EndTime: string; // 17:00

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @CreateDateColumn()
    CreatedAt: Date;

    @UpdateDateColumn()
    UpdatedAt: Date;
}
