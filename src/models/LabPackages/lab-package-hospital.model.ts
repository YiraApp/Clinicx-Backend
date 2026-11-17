import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/** A hospital that offers a lab package. Every package has at least one. */
@Entity({ name: "LabPackageHospitals" })
export class LabPackageHospital {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "int" })
    LabPackageId: number;

    @Column({ type: "int" })
    HospitalId: number;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;
}
