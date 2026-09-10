import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm/index.js";

@Entity({ name: "OfferBanners" })
export class OfferBanner {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    Title?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Description?: string;

    @Column({ type: "nvarchar", length: 1000, nullable: false })
    ImageUrl: string;

    @Column({ type: "varchar", length: 50, nullable: false, default: "browser" })
    RedirectionType: string; // 'browser' or 'in_app'

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    RedirectionUrl?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    InAppRoute?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    InAppParams?: string;

    @Column({ type: "bit", default: true })
    IsAllOrganizations: boolean;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    TargetOrganizationIds?: string; // JSON string e.g. "[1,2]" or comma separated "1,2"

    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "bit", default: true })
    ShowTitle: boolean;

    @Column({ type: "bit", default: true })
    ShowDescription: boolean;

    @Column({ type: "bit", default: true })
    ShowOfferTag: boolean;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    OfferTag?: string;

    @Column({ type: "int", default: 0 })
    DisplayOrder: number;

    @Column({ type: "varchar", length: 50, nullable: false, default: "carousel" })
    Placement: string; // 'carousel' or 'popup'

    @Column({ type: "datetime", nullable: true })
    StartDate?: Date;

    @Column({ type: "datetime", nullable: true })
    EndDate?: Date;

    @Column({ type: "int", nullable: true, default: 0 })
    MaxDisplayCount?: number; // 0 = continuous, 1 = 1 time, 2 = 2 times, etc.

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;

    @UpdateDateColumn({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
