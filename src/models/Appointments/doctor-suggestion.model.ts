import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "DoctorSuggestions" })
export class DoctorSuggestion {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    DoctorId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor: Relation<User>;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: Relation<User>;

    @Column({ type: "nvarchar", length: 255 })
    Title: string;

    @Column({ type: "nvarchar", length: "MAX" })
    Description: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    FilePath?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    FileName?: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
