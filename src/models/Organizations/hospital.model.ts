import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
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

    @Column({ type: "varchar", length: 10, nullable: true })
    CountryCode?: string;


    @Column({ type: "varchar", length: 500, nullable: true })
    Address?: string;

    @Column({ type: "bit", nullable: true })
    TermsAccepted?: boolean;

    @Column({ type: "bit", nullable: true })
    Status?: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    // Contact
    @Column({ type: "varchar", length: 15, nullable: true })
    HelplineNumber?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    Website?: string;

    // Location
    @Column({ type: "varchar", length: 100, nullable: true })
    City?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    State?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    Country?: string;

    @Column({ type: "varchar", length: 10, nullable: true })
    Pincode?: string;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    Latitude?: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    Longitude?: number;

    // Infrastructure
    @Column({ type: "int", nullable: true })
    TotalBeds?: number;

    @Column({ type: "int", nullable: true })
    ICUBeds?: number;

    @Column({ type: "int", nullable: true })
    EmergencyBeds?: number;

    @Column({ type: "int", nullable: true })
    OperationTheatres?: number;

    @Column({ type: "int", nullable: true })
    Ambulances?: number;

    // Timings
    @Column({ type: "varchar", length: 20, nullable: true })
    OpeningTime?: string;

    @Column({ type: "varchar", length: 20, nullable: true })
    ClosingTime?: string;

    @Column({ type: "bit", default: false })
    Is24Hours?: boolean;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "varchar", length: 100, nullable: true })
    CreatedBy?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "bit", default: false })
    IsDeleted?: boolean;
}