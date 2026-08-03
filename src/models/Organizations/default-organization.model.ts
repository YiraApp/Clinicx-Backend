import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { Organization } from "./organization.model.js";
import { Hospital } from "./hospital.model.js";

@Entity({ name: "DefaultOrganizations" })
export class DefaultOrganization {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    OrganizationId: number;

    @ManyToOne(() => Organization, { nullable: true })
    @JoinColumn({ name: "OrganizationId" })
    Organization?: Organization;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital, { nullable: false })
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Hospital;

    @Column({ type: "varchar", length: 255, nullable: true })
    OrganizationName?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    HospitalName?: string;

    @Column({ type: "bit", default: true })
    IsDefault: boolean;

    @Column({ type: "bit", default: true })
    Status: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    UpdatedBy?: string;
}
