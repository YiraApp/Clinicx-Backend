import dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "./src/config/database.js";
import { abdmConfig } from "./src/config/abdm.config.js";
import { timedQuery } from "./src/repositories/Abdm/hiu-data.repository.js";
import {
    convertHiuRecordContent, measureHiuRecords, measureSettled, reclaimDroppedContent, type HiuRecordsSize,
} from "./src/services/Common/hiu-record-content.migration.js";

/**
 * AbdmHiuRecords.Content to VARCHAR(MAX) (up), back to NVARCHAR(MAX) (down), or how it stands
 * (status, read only). Converts in small batches beside a running server (see
 * hiu-record-content.migration.ts); stopped at any point, it resumes when run again.
 *
 *     npx tsx run-hiu-content-migration.ts status|up|down|reclaim
 *
 * Runs against the database in .env: check which one before up or down.
 */

const MB = 1024 * 1024;

const describe = (label: string, size: HiuRecordsSize): string => {
    if (!size.contentType) return `${label}: AbdmHiuRecords.Content does not exist.`;
    const average = (bytes: number, rows: number) => (rows ? Math.round(bytes / rows).toLocaleString("en-US") : "-");
    return [
        `${label}: Content ${size.contentType}${size.pendingType ? ` (unfinished conversion to ${size.pendingType}: ${size.pendingCopied} copied)` : ""}`,
        `  records ${size.records}, with content ${size.withContent}, content ${(size.contentBytes / MB).toFixed(2)} MB`,
        `  average content per record with content: ${average(size.contentBytes, size.withContent)} bytes`,
        size.reservedBytes === null
            ? "  reserved space: not readable (needs VIEW DATABASE STATE)"
            : `  reserved ${(size.reservedBytes / MB).toFixed(2)} MB, average per record ${average(size.reservedBytes, size.records)} bytes`,
    ].join("\n");
};

const main = async () => {
    const command = process.argv[2];
    if (!["status", "up", "down", "reclaim"].includes(command ?? "")) {
        console.error("Usage: npx tsx run-hiu-content-migration.ts status|up|down|reclaim");
        process.exit(2);
    }
    await AppDataSource.initialize();
    // A batch, the swap and the reclaim each get the large writes' limit (or an hour for the reclaim),
    // not the pool's 30 s.
    const run = timedQuery(() => abdmConfig.hiuLargeWriteTimeoutMs);
    const runLong = timedQuery(() => 60 * 60_000);
    try {
        console.log(describe("Before", await measureHiuRecords(run)));
        if (command === "status") return;
        let reclaimed = command === "reclaim";
        if (command !== "reclaim") {
            const result = await convertHiuRecordContent(run, command === "up" ? "varchar" : "nvarchar");
            if (!result.converted) console.log(`Content is ${command === "up" ? "VARCHAR" : "NVARCHAR"}(MAX) already.`);
            // The dropped column's pages, given back now rather than left to a rebuild.
            reclaimed = result.converted;
        }
        if (reclaimed) {
            await reclaimDroppedContent(runLong);
            console.log("Reclaimed the dropped column's space; waiting for SQL Server to free its pages...");
        }
        console.log(describe("After", reclaimed ? await measureSettled(run) : await measureHiuRecords(run)));
    } finally {
        await AppDataSource.destroy();
    }
};

main().catch((error) => {
    // Codes and messages only: nothing here ever holds record content.
    console.error(`Stopped (run it again to resume): ${error?.code ?? ""} ${error?.message ?? error}`);
    process.exit(1);
});
