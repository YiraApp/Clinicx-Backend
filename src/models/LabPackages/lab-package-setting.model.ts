import { Entity, PrimaryColumn, Column } from "typeorm/index.js";

/**
 * What the patient app offers for a hospital's lab package orders, set in Lab Packages → Settings.
 * A hospital with no row uses the defaults: slots and rescheduling on, no collection address.
 */
@Entity({ name: "LabPackageSettings" })
export class LabPackageSetting {
    @PrimaryColumn({ type: "int" })
    HospitalId: number;

    /** Patients choose a visit slot in the app (at checkout or from My Orders). */
    @Column({ type: "bit", default: true })
    PatientSlots: boolean;

    /** Patients can move a chosen slot in the app, until the cutoff before it. */
    @Column({ type: "bit", default: true })
    PatientReschedule: boolean;

    /** Checkout asks for the address where the sample is collected. */
    @Column({ type: "bit", default: false })
    CollectAddress: boolean;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;

    @Column({ type: "uniqueidentifier", nullable: true })
    UpdatedBy?: string | null;
}
