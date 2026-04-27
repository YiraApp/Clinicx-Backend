import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

@Entity({ name: "Addresses" })
export class Address {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 255, nullable: true })
    AddressLine1?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    AddressLine2?: string;

    @Column({ type: "varchar", length: 255, nullable: true })
    Landmark?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    City?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    State?: string;

    @Column({ type: "varchar", length: 10, nullable: true })
    Pincode?: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    Country?: string;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;

    @Column({ type: "bit", nullable: true })
    AddressType?: boolean;
}
