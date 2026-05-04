import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { User } from "../Account/user.model.js";
import { ConsentTemplate } from "./consent-template.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { Organization } from "../Organizations/organization.model.js";

@Entity({ name: "ConsentRequests" })
export class ConsentRequest {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: "MAX" })
    PatientId: string; // User UUID

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: User;

    @Column({ type: "int" })
    TemplateId: number;

    @ManyToOne(() => ConsentTemplate)
    @JoinColumn({ name: "TemplateId" })
    Template: ConsentTemplate;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Hospital;

    @Column({ type: "int" })
    OrganizationId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization: Organization;

    @Column({ type: "nvarchar", length: 50, default: "Pending" })
    Status: string; // Pending, Signed, Rejected

    @Column({ type: "uniqueidentifier", default: () => "NEWID()" })
    RequestLink: string;

    @Column({ type: "datetime", nullable: true })
    SignedAt?: Date;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
