import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A wellness check recorded at the clinic: vital signs, body measurements, activity and sleep,
 * blood glucose and fluid intake, in the units NRCES's wellness value sets use. ABDM shares it as
 * a WellnessRecord.
 */
@Entity({ name: "WellnessRecords" })
export class WellnessRecord {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number | null;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number | null;

    /** Who recorded it (Users.Id). */
    @Column({ type: "uniqueidentifier", nullable: true })
    RecordedById?: string | null;

    @Column({ type: "datetime" })
    RecordedAt: Date;

    /** mmHg */
    @Column({ type: "int", nullable: true })
    Systolic?: number | null;

    /** mmHg */
    @Column({ type: "int", nullable: true })
    Diastolic?: number | null;

    /** beats/minute */
    @Column({ type: "int", nullable: true })
    HeartRate?: number | null;

    /** breaths/minute */
    @Column({ type: "int", nullable: true })
    RespiratoryRate?: number | null;

    @Column({ type: "decimal", precision: 4, scale: 1, nullable: true })
    TemperatureC?: number | null;

    /** % */
    @Column({ type: "int", nullable: true })
    SpO2?: number | null;

    @Column({ type: "decimal", precision: 5, scale: 1, nullable: true })
    HeightCm?: number | null;

    @Column({ type: "decimal", precision: 5, scale: 1, nullable: true })
    WeightKg?: number | null;

    @Column({ type: "int", nullable: true })
    Steps?: number | null;

    /** kcal */
    @Column({ type: "int", nullable: true })
    CaloriesBurned?: number | null;

    @Column({ type: "decimal", precision: 4, scale: 1, nullable: true })
    SleepHours?: number | null;

    /** mg/dL */
    @Column({ type: "decimal", precision: 5, scale: 1, nullable: true })
    BloodGlucose?: number | null;

    @Column({ type: "decimal", precision: 4, scale: 1, nullable: true })
    FluidIntakeLitres?: number | null;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    Notes?: string | null;

    @Column({ type: "bit", default: false })
    IsDeleted: boolean;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    UpdatedBy?: string | null;
}
