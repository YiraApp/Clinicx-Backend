import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

import { PlatformType } from "../../MobileApi/v1/enums/platform.enum.js";

@Entity({ name: "AppVersions" })
export class AppVersion {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 50, nullable: false })
    Platform: PlatformType;

    @Column({ type: "varchar", length: 50, nullable: false })
    Version: string;

    @Column({ type: "varchar", length: 50, nullable: false })
    MinVersion: string;

    @Column({ type: "bit", default: false })
    ForceUpdate: boolean;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Url?: string;

    @Column({ type: "bit", default: true })
    IsLatest: boolean;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
