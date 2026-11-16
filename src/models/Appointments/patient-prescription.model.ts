import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany, Relation, AfterLoad, BeforeInsert } from "typeorm/index.js";
import { compareMedications } from "../../utils/prescription-medications.js";
import { User } from "../Account/user.model.js";
import { PrescriptionDiagnosis } from "./prescription-diagnosis.model.js";
import { PrescriptionMedication } from "./prescription-medication.model.js";
import { PrescriptionLabTest } from "./prescription-lab-test.model.js";

@Entity({ name: "PatientPrescription" })
export class PatientPrescription {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "int", nullable: true, insert: false, update: false })
    PrescriptionNumber?: number;

    @Column({ type: "nvarchar", length: 255, nullable: true, default: null })
    AppointmentId?: string | null;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    MedicalRecordId?: string;

    @Column({ type: "nvarchar", length: 255 })
    PatientId: string;

    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor?: Relation<User>;

    @Column({ type: "datetime", nullable: true, default: () => "GETDATE()" })
    Date?: Date;

    @Column({ type: "datetime", nullable: true, default: () => "GETDATE()" })
    CreatedAt?: Date;

    /**
     * New rows take the app's clock, as every time the app writes does (India time; the driver runs with
     * useUTC: false). The column's GETDATE() default is UTC on Azure SQL, which made a new row read as
     * 5.5 hours old and closed the one-hour edit window at once.
     */
    @BeforeInsert()
    stampCreatedAt() {
        if (!this.CreatedAt) this.CreatedAt = new Date();
    }

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    CreatedBy?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    UpdatedBy?: string;

    @Column({ type: "int", nullable: true })
    OrganizationId?: number;

    @Column({ type: "int", nullable: true })
    HospitalId?: number;

    @Column({ type: "nvarchar", length: 4000, nullable: true })
    Notes?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PdfUrl?: string | null;

    @OneToMany(() => PrescriptionDiagnosis, (diagnosis) => diagnosis.Prescription, { cascade: true })
    Diagnoses?: Relation<PrescriptionDiagnosis[]>;

    @OneToMany(() => PrescriptionMedication, (medication) => medication.Prescription, { cascade: true })
    Medications?: Relation<PrescriptionMedication[]>;

    @OneToMany(() => PrescriptionLabTest, (test) => test.Prescription, { cascade: true })
    LabTests?: PrescriptionLabTest[];

    /** Medicines always come back in the order the doctor wrote them, whichever query loaded them. */
    @AfterLoad()
    sortMedications() {
        if (Array.isArray(this.Medications)) this.Medications.sort(compareMedications);
    }
}
