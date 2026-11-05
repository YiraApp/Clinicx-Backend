import { AppDataSource } from "../../config/database.js";

export interface PincodeMatch {
    pincode: string;
    officeName: string;
    district: string;
    state: string;
    /** "directory": the global pincode table in our database; "india-post": live api.postalpincode.in */
    source: "directory" | "india-post";
    officeType?: string | null;
    delivery?: string | null;
}

const INDIA_POST_API = "https://api.postalpincode.in";

/** "NEW DELHI" → "New Delhi", "JAMMU & KASHMIR" → "Jammu & Kashmir", "K.V.RANGAREDDY" → "K.V.Rangareddy" */
export const titleCase = (s: string) =>
    String(s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s(/&.-])([a-z])/g, (_, p, ch) => p + ch.toUpperCase());

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            row.push(field); field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some(v => v.trim() !== "")) rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    row.push(field);
    if (row.some(v => v.trim() !== "")) rows.push(row);
    return rows;
}

/** [Pincode, OfficeName, OfficeType, Delivery, District, State] */
export type DirectoryRecord = [string, string, string | null, string | null, string, string];

/**
 * India Post's directory CSV (data.gov.in) → one record per post office. Column names are matched
 * loosely (pincode, officename, district/districtname, statename/state, officetype, delivery), so
 * the monthly file and older versions both work. Bad rows and duplicates are skipped.
 */
export function parseDirectoryCsv(text: string): DirectoryRecord[] {
    const rows = parseCsv(text.replace(/^﻿/, ""));
    const header = (rows.shift() || []).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
    const col = (...names: string[]) => header.findIndex(h => names.includes(h));
    const iPin = col("pincode", "pin");
    const iOffice = col("officename", "office", "postofficename", "name");
    const iDistrict = col("district", "districtname");
    const iState = col("statename", "state");
    const iType = col("officetype", "branchtype");
    const iDelivery = col("delivery", "deliverystatus");
    if (iPin < 0 || iOffice < 0 || iDistrict < 0 || iState < 0) {
        throw new Error(`This is not India Post's pincode directory: it needs pincode, office name, district and state columns (found: ${header.slice(0, 12).join(", ")}).`);
    }

    const seen = new Set<string>();
    const records: DirectoryRecord[] = [];
    for (const r of rows) {
        const pin = String(r[iPin] || "").replace(/\D/g, "");
        const office = String(r[iOffice] || "").trim().slice(0, 200);
        const district = titleCase(String(r[iDistrict] || "")).slice(0, 100);
        const state = titleCase(String(r[iState] || "")).slice(0, 100);
        if (pin.length !== 6 || !office || !district || !state || district.toLowerCase() === "na") continue;
        const k = `${pin}|${office.toLowerCase()}|${district.toLowerCase()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        records.push([
            pin,
            office,
            iType >= 0 ? String(r[iType] || "").trim().slice(0, 30) || null : null,
            iDelivery >= 0 ? String(r[iDelivery] || "").trim().slice(0, 30) || null : null,
            district,
            state
        ]);
    }
    if (records.length === 0) throw new Error("No usable rows were found in the file.");
    return records;
}

export interface DirectoryImportJob {
    running: boolean;
    fileName: string | null;
    total: number;
    processed: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
    /** "csv": an uploaded directory replaces the table; "api": a pincode series fetched from India Post is added */
    kind: "csv" | "api";
    /** Pincodes India Post knew (series fetch) */
    found: number;
    /** The pincode series being fetched, e.g. "500" */
    series: string | null;
}

const idleJob = (): DirectoryImportJob => ({
    running: false, fileName: null, total: 0, processed: 0, startedAt: null, finishedAt: null, error: null, kind: "csv", found: 0, series: null
});

/**
 * The global pincode table for lab packages. It is filled from India Post's directory CSV (uploaded
 * on the Lab Packages page, or `npm run import-pincodes`) and from India Post's public API
 * (api.postalpincode.in): a whole pincode series (a city), and every search or lookup answered by the
 * API. Admins pick a package's pincodes from it by state and city/district.
 */
export class PincodeService {
    private job: DirectoryImportJob = idleJob();

    /** True while an uploaded CSV replaces the table (its rows are locked until that commits). */
    private get csvRunning() {
        return this.job.running && this.job.kind === "csv";
    }

    async status() {
        // While an uploaded CSV replaces the table its rows are locked, so report the import alone
        if (this.csvRunning) return { loaded: false, offices: 0, pincodes: 0, states: 0, import: this.job };
        const [row] = await AppDataSource.query(
            "SELECT COUNT(*) AS offices, COUNT(DISTINCT Pincode) AS pincodes, COUNT(DISTINCT State) AS states FROM PincodeDirectory"
        );
        return {
            loaded: Number(row?.offices || 0) > 0,
            offices: Number(row?.offices || 0),
            pincodes: Number(row?.pincodes || 0),
            states: Number(row?.states || 0),
            import: this.job
        };
    }

    /**
     * Replaces the table with India Post's full directory in one transaction (readers keep the old
     * rows until it commits). The CSV is complete, so rows saved from the API are replaced too.
     */
    async importRecords(records: DirectoryRecord[], onProgress?: (done: number) => void) {
        const BATCH = 280; // 7 parameters a row stays under SQL Server's 2100-parameter limit
        await AppDataSource.transaction(async (manager) => {
            await manager.query("DELETE FROM PincodeDirectory");
            for (let i = 0; i < records.length; i += BATCH) {
                const chunk = records.slice(i, i + BATCH);
                const values = chunk.map((_, r) => `(${Array.from({ length: 7 }, (__, c) => `@${r * 7 + c}`).join(", ")})`).join(", ");
                await manager.query(
                    `INSERT INTO PincodeDirectory (Pincode, OfficeName, OfficeType, Delivery, District, State, Source) VALUES ${values}`,
                    chunk.flatMap(rec => [...rec, "india-post-csv"])
                );
                onProgress?.(Math.min(i + BATCH, records.length));
            }
        });
    }

    /**
     * Saves post offices India Post's API returned into the global table, skipping ones already
     * there, so the table grows with every series fetch, search and lookup. Never blocks the caller.
     */
    async storeOffices(matches: PincodeMatch[]): Promise<number> {
        if (this.csvRunning) return 0;
        const seen = new Set<string>();
        const rows = matches.filter(m => {
            const k = `${m.pincode}|${m.officeName.toLowerCase()}`;
            if (!/^\d{6}$/.test(m.pincode) || !m.officeName || !m.district || !m.state || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        let added = 0;
        for (let i = 0; i < rows.length; i += 280) {
            const chunk = rows.slice(i, i + 280);
            const values = chunk.map((_, r) => `(${Array.from({ length: 6 }, (__, c) => `@${r * 6 + c}`).join(", ")})`).join(", ");
            const params = chunk.flatMap(m => [
                m.pincode, m.officeName.slice(0, 200), (m.officeType || "").slice(0, 30) || null,
                (m.delivery || "").slice(0, 30) || null, m.district.slice(0, 100), m.state.slice(0, 100)
            ]);
            const result = await AppDataSource.query(
                `INSERT INTO PincodeDirectory (Pincode, OfficeName, OfficeType, Delivery, District, State, Source)
                 OUTPUT INSERTED.Id
                 SELECT v.Pincode, v.OfficeName, v.OfficeType, v.Delivery, v.District, v.State, 'india-post-api'
                 FROM (VALUES ${values}) AS v (Pincode, OfficeName, OfficeType, Delivery, District, State)
                 WHERE NOT EXISTS (SELECT 1 FROM PincodeDirectory d WHERE d.Pincode = v.Pincode AND d.OfficeName = v.OfficeName)`,
                params
            );
            added += Array.isArray(result) ? result.length : 0;
        }
        return added;
    }

    /**
     * Fetches a whole pincode series from India Post's API in the background and saves it to the
     * global table: "500" asks 500000–500999 (Hyderabad), "560" Bengaluru, "600" Chennai. Indian
     * pincodes are grouped by area, so one series is about one city and its surroundings.
     */
    startSeriesFetch(seriesInput: string): DirectoryImportJob {
        if (this.job.running) throw new Error("A pincode import is already running. Wait for it to finish.");
        const series = String(seriesInput || "").replace(/\D/g, "");
        if (!/^[1-9]\d{2}$/.test(series)) throw new Error("Enter the first 3 digits of the pincodes, e.g. 500 for Hyderabad.");

        const pins = Array.from({ length: 1000 }, (_, i) => `${series}${String(i).padStart(3, "0")}`);
        this.job = { ...idleJob(), running: true, kind: "api", series, fileName: null, total: pins.length, startedAt: new Date() };
        const run = async () => {
            const CONCURRENCY = 10;
            for (let i = 0; i < pins.length; i += CONCURRENCY) {
                const answers = await Promise.all(pins.slice(i, i + CONCURRENCY).map(p => this.indiaPost(`pincode/${p}`, p)));
                const found = answers.flatMap(a => a || []);
                if (found.length > 0) {
                    await this.storeOffices(found);
                    this.job.found += new Set(found.map(f => f.pincode)).size;
                }
                this.job.processed = Math.min(i + CONCURRENCY, pins.length);
            }
        };
        run()
            .then(() => { this.job = { ...this.job, running: false, finishedAt: new Date() }; })
            .catch((err: any) => {
                console.error("[PincodeService] Pincode series fetch failed:", err?.message || err);
                this.job = { ...this.job, running: false, finishedAt: new Date(), error: err?.message || "The fetch stopped; pincodes found so far were kept." };
            });
        return this.job;
    }

    /**
     * Starts loading an uploaded directory CSV in the background (it takes a minute or so); the page
     * follows it through status(). The file is checked before anything is replaced.
     */
    startImport(csvText: string, fileName: string): DirectoryImportJob {
        if (this.job.running) throw new Error("A pincode import is already running. Wait for it to finish.");
        const records = parseDirectoryCsv(csvText);
        this.job = { ...idleJob(), running: true, kind: "csv", fileName, total: records.length, startedAt: new Date() };
        this.importRecords(records, done => { this.job.processed = done; })
            .then(() => { this.job = { ...this.job, running: false, processed: records.length, finishedAt: new Date() }; })
            .catch((err: any) => {
                console.error("[PincodeService] Directory import failed:", err?.message || err);
                this.job = { ...this.job, running: false, finishedAt: new Date(), error: err?.message || "The import failed; the previous directory was kept." };
            });
        return this.job;
    }

    async states(): Promise<{ state: string; districts: number; pincodes: number }[]> {
        const rows = await AppDataSource.query(
            "SELECT State AS state, COUNT(DISTINCT District) AS districts, COUNT(DISTINCT Pincode) AS pincodes FROM PincodeDirectory GROUP BY State ORDER BY State"
        );
        return rows.map((r: any) => ({ state: r.state, districts: Number(r.districts), pincodes: Number(r.pincodes) }));
    }

    async districts(state: string): Promise<{ district: string; pincodes: number }[]> {
        if (!state?.trim()) throw new Error("Choose a state.");
        const rows = await AppDataSource.query(
            "SELECT District AS district, COUNT(DISTINCT Pincode) AS pincodes FROM PincodeDirectory WHERE State = @0 GROUP BY District ORDER BY District",
            [state.trim()]
        );
        return rows.map((r: any) => ({ district: r.district, pincodes: Number(r.pincodes) }));
    }

    /** Every pincode in a state, or in some of its districts, with a few area names for each. */
    async pincodesIn(state: string, districts: string[] = []): Promise<{ pincode: string; district: string; areas: string }[]> {
        if (!state?.trim()) throw new Error("Choose a state.");
        const params: string[] = [state.trim()];
        let districtFilter = "";
        const wanted = Array.from(new Set(districts.map(d => String(d || "").trim()).filter(Boolean))).slice(0, 200);
        if (wanted.length > 0) {
            districtFilter = ` AND District IN (${wanted.map((_, i) => `@${i + 1}`).join(", ")})`;
            params.push(...wanted);
        }
        const rows = await AppDataSource.query(
            `SELECT Pincode AS pincode, MIN(District) AS district, STRING_AGG(CAST(OfficeName AS NVARCHAR(MAX)), ', ') WITHIN GROUP (ORDER BY OfficeName) AS areas
             FROM PincodeDirectory WHERE State = @0${districtFilter} GROUP BY Pincode ORDER BY Pincode`,
            params
        );
        return rows.map((r: any) => ({ pincode: r.pincode, district: r.district, areas: String(r.areas || "").slice(0, 160) }));
    }

    /**
     * Matches a package's uploaded pincodes against the global pincode table only: the ones it has
     * (with their city/district and state) and the ones it does not, which are usually typos.
     */
    async match(pincodes: string[]): Promise<{ matched: { pincode: string; district: string; state: string }[]; unmatched: string[] }> {
        if (this.csvRunning) throw new Error("The global pincode table is being loaded. Try again in a minute.");
        const pins = Array.from(new Set((pincodes || []).map(p => String(p || "").replace(/\D/g, "")).filter(p => p.length === 6)));
        const matched: { pincode: string; district: string; state: string }[] = [];
        for (let i = 0; i < pins.length; i += 1000) {
            const chunk = pins.slice(i, i + 1000);
            const rows = await AppDataSource.query(
                `SELECT Pincode AS pincode, MIN(District) AS district, MIN(State) AS state FROM PincodeDirectory
                 WHERE Pincode IN (${chunk.map((_, j) => `@${j}`).join(", ")}) GROUP BY Pincode`,
                chunk
            );
            matched.push(...rows.map((r: any) => ({ pincode: r.pincode, district: r.district, state: r.state })));
        }
        const found = new Set(matched.map(m => m.pincode));
        return { matched, unmatched: pins.filter(p => !found.has(p)) };
    }

    /**
     * District and state of each pincode (to label pincodes on a package). The directory answers
     * first; pincodes it does not have are asked of India Post's API (up to 25 at a time).
     */
    async lookup(pincodes: string[]): Promise<{ pincode: string; district: string; state: string }[]> {
        const pins = Array.from(new Set((pincodes || []).map(p => String(p || "").replace(/\D/g, "")).filter(p => p.length === 6)));
        const out: { pincode: string; district: string; state: string }[] = [];
        if (!this.csvRunning) {
            for (let i = 0; i < pins.length; i += 1000) {
                const chunk = pins.slice(i, i + 1000);
                const rows = await AppDataSource.query(
                    `SELECT Pincode AS pincode, MIN(District) AS district, MIN(State) AS state FROM PincodeDirectory
                     WHERE Pincode IN (${chunk.map((_, j) => `@${j}`).join(", ")}) GROUP BY Pincode`,
                    chunk
                );
                out.push(...rows.map((r: any) => ({ pincode: r.pincode, district: r.district, state: r.state })));
            }
        }

        // Pincodes the table does not have yet: ask India Post (up to 100 a call) and keep the answers
        const found = new Set(out.map(r => r.pincode));
        const missing = pins.filter(p => !found.has(p)).slice(0, 100);
        const fromApi: PincodeMatch[] = [];
        for (let i = 0; i < missing.length; i += 10) {
            const answers = await Promise.all(missing.slice(i, i + 10).map(p => this.indiaPost(`pincode/${p}`, p)));
            answers.forEach(matches => {
                if (!matches || matches.length === 0) return;
                fromApi.push(...matches);
                out.push({ pincode: matches[0].pincode, district: matches[0].district, state: matches[0].state });
            });
        }
        if (fromApi.length > 0) await this.storeOffices(fromApi).catch(() => 0);
        return out;
    }

    /**
     * India Post's public API; null when it cannot be reached. The pincode comes back as "Pincode"
     * or "PINCode" depending on the endpoint; a by-pincode answer without it uses the pincode asked.
     */
    private async indiaPost(pathPart: string, askedPincode?: string): Promise<PincodeMatch[] | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(`${INDIA_POST_API}/${pathPart}`, { signal: controller.signal, headers: { Accept: "application/json" } });
            if (!res.ok) return null;
            const body: any = await res.json();
            const first = Array.isArray(body) ? body[0] : body;
            if (!first || String(first.Status).toLowerCase() !== "success" || !Array.isArray(first.PostOffice)) return [];
            const pinOf = (p: any) => String(p.Pincode ?? p.PINCode ?? p.PinCode ?? askedPincode ?? "").replace(/\D/g, "");
            return first.PostOffice
                .filter((p: any) => pinOf(p).length === 6)
                .map((p: any) => ({
                    pincode: pinOf(p),
                    officeName: String(p.Name || "").trim(),
                    district: titleCase(p.District),
                    state: titleCase(p.State),
                    source: "india-post" as const,
                    officeType: p.BranchType ? String(p.BranchType) : null,
                    delivery: p.DeliveryStatus ? String(p.DeliveryStatus) : null
                }));
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private async searchDirectory(q: string): Promise<PincodeMatch[]> {
        if (this.csvRunning) return []; // the table is being replaced
        const isPin = /^\d{6}$/.test(q);
        const rows = await AppDataSource.query(
            isPin
                ? "SELECT TOP 100 Pincode, OfficeName, District, State FROM PincodeDirectory WHERE Pincode = @0 ORDER BY OfficeName"
                : "SELECT TOP 100 Pincode, OfficeName, District, State FROM PincodeDirectory WHERE OfficeName LIKE @0 OR District LIKE @0 ORDER BY State, District, OfficeName",
            [isPin ? q : `%${q}%`]
        );
        return rows.map((r: any) => ({ pincode: r.Pincode, officeName: r.OfficeName, district: r.District, state: r.State, source: "directory" as const }));
    }

    /**
     * Search by a 6-digit pincode or an area / post office name (3+ letters). India Post's live API
     * answers first; the directory in our database answers when it cannot be reached.
     */
    async search(query: string): Promise<{ results: PincodeMatch[]; source: "india-post" | "directory" }> {
        const q = String(query || "").trim();
        const isPin = /^\d{6}$/.test(q);
        if (!isPin && q.replace(/[^a-z]/gi, "").length < 3) throw new Error("Type a 6-digit pincode or at least 3 letters of an area name.");

        const live = await this.indiaPost(isPin ? `pincode/${q}` : `postoffice/${encodeURIComponent(q)}`, isPin ? q : undefined);
        if (live && live.length > 0) {
            const seen = new Set<string>();
            const results = live.filter(m => {
                const k = `${m.pincode}|${m.officeName.toLowerCase()}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            }).slice(0, 100);
            // Keep what India Post answered in the global table
            await this.storeOffices(results).catch(() => 0);
            return { results, source: "india-post" };
        }
        return { results: await this.searchDirectory(q), source: "directory" };
    }
}

export const pincodeService = new PincodeService();
