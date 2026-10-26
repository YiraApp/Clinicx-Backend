import { Entity, PrimaryGeneratedColumn, Column } from "typeorm/index.js";

/**
 * One ABDM exchange, keyed by request id.
 * Outbound: a call this system made that ABDM answers on a callback. The row exists before the
 * call is sent, and moves sent → accepted (2xx) or refused (synchronous error) → answered.
 * Inbound: a request ABDM made of this HIP (discovery, link init/confirm, consent notification,
 * health information request), stored on arrival before anything reads it.
 * Bodies are kept with credentials masked; headers as names and lengths only.
 */
@Entity({ name: "AbdmExchanges" })
export class AbdmExchange {
    @PrimaryGeneratedColumn()
    Id: number;

    /** "outbound" or "inbound". */
    @Column({ type: "varchar", length: 10 })
    Direction: string;

    /** The REQUEST-ID this system sent (outbound), or the one ABDM sent (inbound). */
    @Column({ type: "varchar", length: 64 })
    RequestId: string;

    /** The call's path, such as /api/hiecm/v3/token/generate-token. */
    @Column({ type: "varchar", length: 200 })
    Operation: string;

    @Column({ type: "varchar", length: 50, nullable: true })
    HipId?: string | null;

    /** sent, accepted, refused, answered (outbound); received (inbound). */
    @Column({ type: "varchar", length: 20 })
    State: string;

    /** The synchronous HTTP status of an outbound call. */
    @Column({ type: "int", nullable: true })
    HttpStatus?: number | null;

    @Column({ type: "varchar", length: 30, nullable: true })
    ErrorCode?: string | null;

    @Column({ type: "nvarchar", length: 500, nullable: true })
    ErrorMessage?: string | null;

    /** The callback that answered (outbound) or the request itself (inbound). */
    @Column({ type: "varchar", length: 200, nullable: true })
    CallbackPath?: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    CallbackRequestId?: string | null;

    /** JSON: header name to value length. Never a value. */
    @Column({ type: "nvarchar", length: 1000, nullable: true })
    CallbackHeaders?: string | null;

    /** JSON, with credentials masked. */
    @Column({ type: "nvarchar", length: "MAX", nullable: true })
    CallbackBody?: string | null;

    @Column({ type: "datetime", nullable: true })
    CallbackAt?: Date | null;

    @Column({ type: "datetime", default: () => "GETDATE()" })
    CreatedAt: Date;

    @Column({ type: "datetime", nullable: true })
    UpdatedAt?: Date | null;
}
