import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Organization } from "./organization.model.js";
import { Hospital } from "./hospital.model.js";

@Entity("PatientRegistrations")
export class PatientRegistration {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    User: User;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Organization;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Hospital;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Allergies?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    MedicalHistory?: string;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @CreateDateColumn()
    CreatedAt: Date;

    @UpdateDateColumn()
    UpdatedAt: Date;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string;
}
