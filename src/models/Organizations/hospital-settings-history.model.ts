import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation, CreateDateColumn } from "typeorm/index.js";
import { Hospital } from "./hospital.model.js";
import { HospitalSetting } from "./hospital-settings.model.js";

@Entity({ name: "HospitalSettingsHistory" })
export class HospitalSettingsHistory {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    HospitalSettingId: number;

    @ManyToOne(() => HospitalSetting)
    @JoinColumn({ name: "HospitalSettingId" })
    HospitalSetting?: Relation<HospitalSetting>;

    @Column({ type: "int" })
    HospitalId: number;

    @ManyToOne(() => Hospital)
    @JoinColumn({ name: "HospitalId" })
    Hospital?: Relation<Hospital>;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "varchar", length: 50, default: "UPDATE" })
    Action: string; // "CREATE" | "UPDATE" | "RESET"

    @Column({ type: "int", default: 1 })
    Version: number;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    ChangedFields?: string | null; // e.g. "TakeBuffer, BufferMinutes, OnlinePayments"

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    OldValues?: string | null; // JSON snapshot of previous settings

    @Column({ type: "nvarchar", length: "MAX" })
    NewValues: string; // JSON snapshot of updated settings

    @Column({ type: "int", nullable: true })
    ChangedBy?: number | null; // User Id who made the change

    @Column({ type: "nvarchar", length: 150, nullable: true })
    ChangedByName?: string | null; // Name of Admin/User

    @Column({ type: "nvarchar", length: 100, nullable: true })
    ChangedByRole?: string | null; // Role (e.g. "Hospital Admin", "Front Desk", "Org Admin")

    @Column({ type: "nvarchar", length: 500, nullable: true })
    ChangeReason?: string | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    IpAddress?: string | null;

    @CreateDateColumn({ type: "datetime" })
    CreatedAt: Date;
}
