import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { Organization } from "./organization.model.js";

@Entity({ name: "Hospitals" })
export class Hospital {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 50, nullable: true })
    HospitalCode?: string;

    @Column({ type: "int" })
    OrganizationId: number;

    @ManyToOne(() => Organization)
    @JoinColumn({ name: "OrganizationId" })
    Organization: Organization;

    @Column({ type: "varchar", length: 100, nullable: true })
    HospitalType?: string;

    @Column({ type: "varchar", length: 255 })
    Name: string;

    @Column({ type: "varchar", length: 256, nullable: true })
    Email?: string;

    @Column({ type: "varchar", length: 15, nullable: true })
    MobileNumber?: string;

    @Column({ type: "varchar", length: 500, nullable: true })
    Address?: string;

    @Column({ type: "bit", nullable: true })
    TermsAccepted?: boolean;

    @Column({ type: "bit", nullable: true })
    Status?: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;
}
