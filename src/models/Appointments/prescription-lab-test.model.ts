import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Relation } from "typeorm/index.js";
import { PatientPrescription } from "./patient-prescription.model.js";

/** A lab test a doctor ordered. The name is copied so old prescriptions survive list edits. */
@Entity({ name: "PrescriptionLabTests" })
export class PrescriptionLabTest {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "uniqueidentifier" })
    PrescriptionId: string;

    @ManyToOne(() => PatientPrescription, (prescription) => prescription.LabTests, { onDelete: "CASCADE" })
    @JoinColumn({ name: "PrescriptionId" })
    Prescription?: Relation<PatientPrescription>;

    @Column({ type: "int", nullable: true })
    HospitalLabTestId?: number | null;

    @Column({ type: "nvarchar", length: 200 })
    TestName: string;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    Category?: string | null;

    @Column({ type: "nvarchar", length: 20, default: "Routine" })
    Priority: string;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    Instructions?: string | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
