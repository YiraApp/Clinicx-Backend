import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity({ name: "UserOTP" })
export class UserOTP {
    @PrimaryGeneratedColumn()
    Id: number;

    @Column({ type: "varchar", length: 256 })
    Contact: string; // Email or Phone Number

    @Column({ type: "varchar", length: 10 })
    OTP: string;

    @Column({ type: "varchar", length: 100, nullable: true })
    SessionId?: string | null;

    @Column({ type: "int", default: 0 })
    AttemptCount: number;

    @Column({ type: "datetime" })
    ExpiryTime: Date;

    @Column({ type: "bit", default: false })
    IsExpired: boolean;

    @Column({ type: "varchar", length: 50, nullable: true })
    CreatedBy?: string | null;

    @Column({ type: "varchar", length: 50, nullable: true })
    UpdatedBy?: string | null;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedDate: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedDate?: Date | null;

    @Column({ type: "nvarchar", length: 20, nullable: true })
    OTPType?: string | null; // "EMAIL" or "MOBILE"

    @Column({ type: "nvarchar", length: 50, nullable: true })
    Purpose?: string | null; // "VERIFICATION", "PASSWORD_RESET", etc.

    @Column({ type: "varchar", length: 10, nullable: true })
    CountryCode?: string | null;
}
