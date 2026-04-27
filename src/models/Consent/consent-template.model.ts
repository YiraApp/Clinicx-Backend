import { Entity, PrimaryGeneratedColumn, Column, OneToMany, ManyToOne, JoinColumn, Relation } from "typeorm";
import { SignatureField } from "./signature-field.model.js";
import { Hospital } from "../Organizations/hospital.model.js";
import { Organization } from "../Organizations/organization.model.js";

@Entity({ name: "ConsentTemplates" })
export class ConsentTemplate {
    @PrimaryGeneratedColumn()
    TemplateId: number;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital: Relation<Hospital>;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization: Relation<Organization>;

    @Column({ type: "nvarchar", length: 200 })
    Name: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Description?: string;

    @Column({ type: "nvarchar", length: "MAX" })
    PdfUrl: string;

    @Column({ type: "int", nullable: true })
    Version?: number;

    @Column({ type: "bit", default: 1 })
    Status: boolean;

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @OneToMany(() => SignatureField, (field: SignatureField) => field.Template)
    SignatureFields: Relation<SignatureField>[];
}
