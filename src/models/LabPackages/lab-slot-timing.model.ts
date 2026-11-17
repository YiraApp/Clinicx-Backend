import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A visit slot a hospital offers for lab package orders, e.g. 10:00–11:00 (India time). Set in
 * Lab Package Orders → Settings; a hospital with no rows uses the default 10 AM – 6 PM hourly slots.
 */
@Entity({ name: "LabSlotTimings" })
export class LabSlotTiming {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalId: number;

    /** "HH:mm", 24-hour */
    @Column({ type: "varchar", length: 5 })
    StartTime: string;

    @Column({ type: "varchar", length: 5 })
    EndTime: string;

    @Column({ type: "bit", default: true })
    IsActive: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "uniqueidentifier", nullable: true })
    CreatedBy?: string | null;
}
