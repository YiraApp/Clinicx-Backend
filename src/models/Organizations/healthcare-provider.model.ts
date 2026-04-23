import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm";
import { User } from "../Account/user.model.js";
import { Hospital } from "./hospital.model.js";

@Entity("HealthcareProviders")
export class HealthcareProvider {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: User;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "nvarchar", length: 150 })
    Specialty: string;

    @Column({ type: "nvarchar", length: 150, nullable: true })
    SubSpecialty: string;

    @Column({ type: "nvarchar", length: 150 })
    Department: string;

    @Column({ type: "nvarchar", length: 100 })
    RegistrationNumber: string;

    @Column({ type: "nvarchar", length: 250, nullable: true })
    Qualification: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Experience: string;

    @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
    ConsultationFee: number;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Bio: string;


    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @CreateDateColumn()
    CreatedAt: Date;

    @UpdateDateColumn()
    UpdatedAt: Date;
}
