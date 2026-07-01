import { Entity, PrimaryColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "TreatmentPlans" })
@Index(["OrgId", "HospitalId"])
export class TreatmentPlan {
    @PrimaryColumn("uniqueidentifier")
    TreatmentPlanId: string;

    @Column({ type: "int" })
    OrgId: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number | null;

    @Column({ type: "nvarchar", length: 255 })
    Name: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Description?: string | null;

    @Column({ type: "decimal", precision: 18, scale: 2, default: 0 })
    Amount: number;

    @Column({ type: "varchar", length: 50, default: "Active" })
    Status: string;

    @Column({ type: "bit", default: 0 })
    IsDeleted: boolean;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;

    @UpdateDateColumn({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
