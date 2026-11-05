import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * The global pincode table: one row per post office, from India Post's "All India Pincode Directory"
 * (data.gov.in, Government Open Data Licence – India) and from India Post's API (api.postalpincode.in).
 * Used to add a lab package's pincodes by state and city/district.
 */
@Entity({ name: "PincodeDirectory" })
export class PincodeDirectory {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 6 })
    Pincode: string;

    @Column({ type: "nvarchar", length: 200 })
    OfficeName: string;

    @Column({ type: "varchar", length: 30, nullable: true })
    OfficeType?: string | null;

    @Column({ type: "varchar", length: 30, nullable: true })
    Delivery?: string | null;

    @Column({ type: "nvarchar", length: 100 })
    District: string;

    @Column({ type: "nvarchar", length: 100 })
    State: string;

    /** "india-post-csv" (uploaded directory) or "india-post-api" (saved from India Post's API) */
    @Column({ type: "varchar", length: 20, nullable: true })
    Source?: string | null;
}
