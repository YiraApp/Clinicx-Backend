import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm/index.js";
import { User } from "./user.model.js";

@Entity({ name: "UserTokens" })
export class UserToken {
    @PrimaryGeneratedColumn()
    TokenId: number;

    @Column({ type: "uniqueidentifier" })
    UserId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: "UserId" })
    user: User;

    @Column({ type: "nvarchar", length: "MAX", nullable: false })
    AccessToken: string;

    @Column({ type: "nvarchar", length: "MAX", nullable: false })
    RefreshToken: string;

    @Column({ type: "datetime", nullable: false })
    AccessTokenExpiry: Date;

    @Column({ type: "datetime", nullable: false })
    RefreshTokenExpiry: Date;

    @Column({ type: "nvarchar", length: 255, nullable: true })
    DeviceInfo?: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    IPAddress?: string;

    @Column({ type: "bit", default: false })
    IsRevoked: boolean;

    @Column({ type: "datetime", default: () => "getdate()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date;
}
