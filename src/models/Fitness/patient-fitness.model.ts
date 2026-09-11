import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation, Index, Unique } from "typeorm/index.js";
import { User } from "../Account/user.model.js";

@Entity({ name: "PatientFitnessData" })
@Unique(["PatientId", "Date"])
@Index("IX_PatientFitness_PatientId_Date", ["PatientId", "Date"])
export class PatientFitnessData {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: Relation<User>;

    @Column({ type: "date" })
    Date: string; // YYYY-MM-DD

    // Activity & Movement
    @Column({ type: "int", nullable: true, default: 0 })
    Steps: number;

    @Column({ type: "float", nullable: true, default: 0 })
    Calories: number;

    @Column({ type: "float", nullable: true, default: 0 })
    DistanceMeters: number;

    @Column({ type: "int", nullable: true, default: 0 })
    ActiveMinutes: number;

    @Column({ type: "int", nullable: true, default: 0 })
    FlightsClimbed: number;

    // Cardiovascular Vitals
    @Column({ type: "float", nullable: true })
    HeartRateAvg?: number;

    @Column({ type: "float", nullable: true })
    HeartRateMin?: number;

    @Column({ type: "float", nullable: true })
    HeartRateMax?: number;

    @Column({ type: "float", nullable: true })
    RestingHeartRate?: number;

    @Column({ type: "float", nullable: true })
    BloodOxygen?: number;

    @Column({ type: "float", nullable: true })
    BloodPressureSys?: number;

    @Column({ type: "float", nullable: true })
    BloodPressureDia?: number;

    // Sleep Architecture
    @Column({ type: "int", nullable: true, default: 0 })
    SleepMinutes: number;

    @Column({ type: "int", nullable: true, default: 0 })
    SleepDeepMinutes: number;

    @Column({ type: "int", nullable: true, default: 0 })
    SleepRemMinutes: number;

    @Column({ type: "int", nullable: true, default: 0 })
    SleepLightMinutes: number;

    @Column({ type: "int", nullable: true, default: 0 })
    SleepAwakeMinutes: number;

    // Body Composition & Hydration
    @Column({ type: "float", nullable: true })
    WeightKg?: number;

    @Column({ type: "float", nullable: true })
    Bmi?: number;

    @Column({ type: "float", nullable: true })
    WaterLiters?: number;

    @Column({ type: "float", nullable: true })
    BloodGlucoseMgDl?: number;

    // Metadata & JSON dumps
    @Column({ type: "varchar", length: 50 })
    Source: string; // 'AppleHealth' | 'GoogleHealthConnect'

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RawHourlyJson?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    RawMetricsJson?: string;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
