import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { User } from "../Account/user.model.js";
import { Appointment } from "./appointment.model.js";

@Entity({ name: "PatientMedicalRecord" })
export class PatientMedicalRecord {
    @PrimaryGeneratedColumn("uuid")
    Id: string;

    @Column({ type: "int", nullable: true })
    AppointmentId?: number;

    @ManyToOne(() => Appointment)
    @JoinColumn({ name: "AppointmentId", referencedColumnName: "Id" })
    Appointment?: Relation<Appointment>;

    @Column({ type: "uniqueidentifier" })
    PatientId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "PatientId" })
    Patient: Relation<User>;

    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "DoctorId" })
    Doctor?: Relation<User>;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    Date: Date;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Type?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ChiefComplaint?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    ChiefComplaintConceptId?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Symptoms?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    SymptomConceptId?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PhysicalExamination?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    PhysicalExaminationConceptId?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Diagnosis?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    DiagnosisConceptId?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Treatment?: string;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    TreatmentConceptId?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    BloodPressure?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    HeartRate?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Temperature?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Weight?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Height?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    SpO2?: string;

    // Clinical history and examination, laid out the way doctors write an OPD note.
    /** Drug, food or other allergies; printed first on the prescription. */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Allergies?: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    FamilyHistory?: string;

    @Column({ type: "nvarchar", length: 50, nullable: true })
    RespiratoryRate?: string;

    /** H/O: onset, progression, severity, associated symptoms. */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    HistoryOfPresentIllness?: string;

    /** Relevant past and comorbid history (DM, HTN, asthma, thyroid, past surgeries). */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    PastHistory?: string;

    /** Medicines the patient already takes, to check for interactions. */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    CurrentMedications?: string;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    CvsExamination?: string;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    RespiratoryExamination?: string;

    /** P/A: per abdomen. */
    @Column({ type: "nvarchar", length: 1000, nullable: true })
    AbdomenExamination?: string;

    @Column({ type: "nvarchar", length: 1000, nullable: true })
    CnsExamination?: string;

    /** Provisional or Confirmed. */
    @Column({ type: "nvarchar", length: 20, nullable: true })
    DiagnosisType?: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Status?: string;

    @Column({ type: "datetime", nullable: true })
    FollowUpDate?: Date;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

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
}
