import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * A lab or imaging report entered at the clinic: the test, its results with units and reference
 * ranges, and the conclusion, with the report file attached when there is one. ABDM shares it as a
 * DiagnosticReport once it is Final. Results is a JSON array of
 * { name, conceptId?, value?, valueText?, unit?, low?, high?, referenceText?, interpretation? };
 * ConclusionCodes a JSON array of { text, conceptId? }, conceptId a SNOMED CT concept.
 */
@Entity({ name: "DiagnosticReports" })
export class PatientDiagnosticReport {
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

    /** The doctor who ordered or reported it (Users.Id). */
    @Column({ type: "uniqueidentifier", nullable: true })
    DoctorId?: string | null;

    /** Lab or Imaging. */
    @Column({ type: "varchar", length: 20 })
    Category: string;

    @Column({ type: "nvarchar", length: 200 })
    TestName: string;

    @Column({ type: "varchar", length: 20, nullable: true })
    TestConceptId?: string | null;

    @Column({ type: "nvarchar", length: 100, nullable: true })
    SpecimenType?: string | null;

    @Column({ type: "varchar", length: 20, nullable: true })
    SpecimenConceptId?: string | null;

    @Column({ type: "datetime", nullable: true })
    CollectedAt?: Date | null;

    @Column({ type: "datetime" })
    IssuedAt: Date;

    /** The lab or imaging centre. */
    @Column({ type: "nvarchar", length: 200, nullable: true })
    PerformedBy?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Results?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    Conclusion?: string | null;

    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    ConclusionCodes?: string | null;

    /** The report file, uploaded (MedicalDocuments.Id). */
    @Column({ type: "int", nullable: true })
    DocumentId?: number | null;

    /** Draft or Final. */
    @Column({ type: "varchar", length: 20, default: "Draft" })
    Status: string;

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
