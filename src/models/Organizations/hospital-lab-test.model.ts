import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/** One test in a hospital's own lab list. */
@Entity({ name: "HospitalLabTests" })
export class HospitalLabTest {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    @Column({ type: "nvarchar", length: 200 })
    TestName: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    TestCode?: string | null;

    @Column({ type: "nvarchar", length: 100 })
    Category: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    SampleType?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2, nullable: true })
    Price?: number | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Preparation?: string | null;

    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
