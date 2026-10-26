import { AppDataSource } from "../../config/database.js";
import { AbdmExchange } from "../../models/Abdm/abdm-exchange.model.js";
import type { ExchangeRecorder } from "../../services/Abdm/abdm-gateway.service.js";
import type { CallbackStore, StoredCallback } from "../../services/Abdm/abdm-callback.service.js";

/** SQL Server's duplicate key errors (unique constraint, unique index). */
const isDuplicateKey = (error: any): boolean => [2627, 2601].includes(error?.number ?? error?.driverError?.number);

/**
 * AbdmExchanges: outbound calls ABDM answers on a callback, and requests ABDM makes of the HIP.
 * State changes are conditional updates, so a callback racing the HTTP response, or a second
 * delivery of the same callback, can never overwrite or reopen an exchange.
 */
export class AbdmExchangeRepository implements ExchangeRecorder, CallbackStore {
    private get exchanges() {
        return AppDataSource.getRepository(AbdmExchange);
    }

    async sent(exchange: { requestId: string; operation: string; hipId: string | null }): Promise<void> {
        await this.exchanges.insert({
            Direction: "outbound",
            RequestId: exchange.requestId,
            Operation: exchange.operation.slice(0, 200),
            HipId: exchange.hipId,
            State: "sent",
        });
    }

    async settled(requestId: string, outcome: Parameters<ExchangeRecorder["settled"]>[1]): Promise<void> {
        await AppDataSource.query(
            `UPDATE AbdmExchanges
             SET State = @0, HttpStatus = @1, ErrorCode = @2, ErrorMessage = @3, UpdatedAt = GETDATE()
             WHERE Direction = 'outbound' AND RequestId = @4 AND State = 'sent'`,
            [outcome.state, outcome.httpStatus, outcome.errorCode ?? null, outcome.errorMessage?.slice(0, 500) ?? null, requestId]
        );
    }

    async answer(answeredRequestId: string, callback: StoredCallback): Promise<"answered" | "duplicate" | "unknown"> {
        const updated = await AppDataSource.query(
            `UPDATE AbdmExchanges
             SET State = 'answered', CallbackPath = @0, CallbackRequestId = @1, CallbackHeaders = @2,
                 CallbackBody = @3, CallbackAt = @4, UpdatedAt = GETDATE()
             OUTPUT inserted.Id
             WHERE Direction = 'outbound' AND RequestId = @5 AND HipId = @6 AND State IN ('sent', 'accepted')`,
            [callback.path, callback.requestId, callback.headers.slice(0, 1000), callback.body, callback.receivedAt, answeredRequestId, callback.hipId]
        );
        if (Array.isArray(updated) && updated.length > 0) return "answered";

        const existing = await this.exchanges.findOne({
            where: { Direction: "outbound", RequestId: answeredRequestId },
            select: { Id: true, State: true },
        });
        return existing?.State === "answered" ? "duplicate" : "unknown";
    }

    async receive(callback: StoredCallback): Promise<"stored" | "duplicate"> {
        try {
            await this.exchanges.insert({
                Direction: "inbound",
                RequestId: callback.requestId,
                Operation: callback.path,
                HipId: callback.hipId,
                State: "received",
                CallbackPath: callback.path,
                CallbackRequestId: callback.requestId,
                CallbackHeaders: callback.headers.slice(0, 1000),
                CallbackBody: callback.body,
                CallbackAt: callback.receivedAt,
            });
            return "stored";
        } catch (error) {
            if (isDuplicateKey(error)) return "duplicate";
            throw error;
        }
    }
}

export const abdmExchangeRepository = new AbdmExchangeRepository();
