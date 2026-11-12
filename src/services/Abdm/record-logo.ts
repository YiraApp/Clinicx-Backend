/**
 * The hospital's logo for the letterhead of an ABDM record's PDF, as the clinic's prescription PDF
 * shows it. Fetched from the hospital's ImageUrl and kept for a while, so building a visit's records
 * does not fetch it once per record. Only a PNG or JPEG of a sensible size is used (what PDFKit
 * draws). A hospital without one, or whose logo can't be fetched, gets the logo the prescription PDF
 * falls back to; nothing here ever stops a record being built.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const MAX_BYTES = 1_500_000;
const MAX_PIXELS = 4_000_000;
const KEEP_MS = 30 * 60_000;
/** A failed fetch is tried again sooner. */
const RETRY_MS = 2 * 60_000;
const TIMEOUT_MS = 4_000;

export const isLogoImage = (data: Buffer): boolean =>
    data.length >= 4 && (
        (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) // PNG
        || (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) // JPEG
    );

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG as an opaque RGB PNG, its transparency laid over white. PDFKit draws a PNG with an alpha
 * channel or transparent colours only after an asynchronous step, which a record's PDF, written in
 * one go, cannot wait for; an RGB PNG it draws at once. Null for a PNG this does not read (16-bit,
 * interlaced, or damaged): the letterhead then goes without a logo.
 */
export const opaquePng = (png: Buffer): Buffer | null => {
    try {
        if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
        let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
        let palette = Buffer.alloc(0);
        let trns: Buffer | null = null;
        const idat: Buffer[] = [];
        for (let at = 8; at + 8 <= png.length;) {
            const length = png.readUInt32BE(at);
            const type = png.toString("latin1", at + 4, at + 8);
            const data = png.subarray(at + 8, at + 8 + length);
            if (type === "IHDR") {
                width = data.readUInt32BE(0);
                height = data.readUInt32BE(4);
                depth = data[8]!;
                colorType = data[9]!;
                interlace = data[12]!;
            } else if (type === "PLTE") palette = Buffer.from(data);
            else if (type === "tRNS") trns = Buffer.from(data);
            else if (type === "IDAT") idat.push(data);
            else if (type === "IEND") break;
            at += 12 + length;
        }
        const channels = CHANNELS[colorType];
        const subByte = depth < 8 && (colorType === 0 || colorType === 3);
        if (!channels || !width || !height || width * height > MAX_PIXELS || interlace !== 0 || !(depth === 8 || subByte)) return null;

        const stride = Math.ceil((width * channels * depth) / 8);
        const bpp = Math.max(1, (channels * depth) / 8);
        const raw = inflateSync(Buffer.concat(idat));
        if (raw.length < height * (stride + 1)) return null;
        // Undo each row's filter (PNG spec 9.2)
        const rows = Buffer.alloc(height * stride);
        for (let y = 0; y < height; y++) {
            const filter = raw[y * (stride + 1)]!;
            const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
            const row = rows.subarray(y * stride, (y + 1) * stride);
            const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
            for (let i = 0; i < stride; i++) {
                const a = i >= bpp ? row[i - bpp]! : 0;
                const b = up ? up[i]! : 0;
                const c = up && i >= bpp ? up[i - bpp]! : 0;
                let predictor = 0;
                if (filter === 1) predictor = a;
                else if (filter === 2) predictor = b;
                else if (filter === 3) predictor = (a + b) >> 1;
                else if (filter === 4) {
                    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                } else if (filter !== 0) return null;
                row[i] = (src[i]! + predictor) & 0xff;
            }
        }

        const sample = (row: Buffer, index: number): number => {
            if (depth === 8) return row[index]!;
            const bit = index * depth;
            return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        };
        const scale = (v: number) => (colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
        const out = Buffer.alloc(height * (width * 3 + 1));
        for (let y = 0; y < height; y++) {
            const row = rows.subarray(y * stride, (y + 1) * stride);
            const line = out.subarray(y * (width * 3 + 1), (y + 1) * (width * 3 + 1));
            line[0] = 0;
            for (let x = 0; x < width; x++) {
                let r: number, g: number, b: number, alpha = 255;
                if (colorType === 3) {
                    const index = sample(row, x);
                    [r, g, b] = [palette[index * 3] ?? 0, palette[index * 3 + 1] ?? 0, palette[index * 3 + 2] ?? 0];
                    alpha = trns && index < trns.length ? trns[index]! : 255;
                } else if (colorType === 0 || colorType === 4) {
                    const raw0 = sample(row, x * channels);
                    r = g = b = scale(raw0);
                    if (colorType === 4) alpha = row[x * 2 + 1]!;
                    else if (trns && trns.length >= 2 && trns.readUInt16BE(0) === raw0) alpha = 0;
                } else {
                    [r, g, b] = [row[x * channels]!, row[x * channels + 1]!, row[x * channels + 2]!];
                    if (colorType === 6) alpha = row[x * 4 + 3]!;
                    else if (trns && trns.length >= 6 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b) alpha = 0;
                }
                // Over white
                const over = (v: number) => Math.round((v * alpha + 255 * (255 - alpha)) / 255);
                line[1 + x * 3] = over(r);
                line[2 + x * 3] = over(g);
                line[3 + x * 3] = over(b);
            }
        }
        const header = Buffer.alloc(13);
        header.writeUInt32BE(width, 0);
        header.writeUInt32BE(height, 4);
        header[8] = 8; // bit depth
        header[9] = 2; // RGB
        return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(out, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
    } catch {
        return null;
    }
};

/** The logo as the record's PDF can draw it at once: a JPEG as it is, a PNG made opaque. */
export const drawableLogo = (data: Buffer): Buffer | null =>
    data[0] === 0xff && data[1] === 0xd8 ? data : opaquePng(data);

type Fetch =(url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

/** The logo the clinic's prescription PDF falls back to when the hospital has none. */
const FALLBACK = path.resolve(process.cwd(), "public/images/hospital_logo.png");

export class RecordLogos {
    private readonly cache = new Map<string, { logo: Promise<Buffer | null>; until: number }>();
    private fallbackLogo: Buffer | null | undefined;

    constructor(
        private readonly fetcher: Fetch = (url, init) => fetch(url, init),
        private readonly now: () => number = () => Date.now(),
        private readonly fallbackPath: string | null = FALLBACK,
    ) {}

    /** The logo at [url]; without one, the logo the prescription PDF uses then; or null. */
    async get(url: string | null | undefined): Promise<Buffer | null> {
        return (await this.fetched(url)) ?? this.fallback();
    }

    private fallback(): Buffer | null {
        if (this.fallbackLogo === undefined) {
            try {
                const data = this.fallbackPath ? readFileSync(this.fallbackPath) : null;
                this.fallbackLogo = data && isLogoImage(data) ? drawableLogo(data) : null;
            } catch {
                this.fallbackLogo = null;
            }
        }
        return this.fallbackLogo;
    }

    private fetched(url: string | null | undefined): Promise<Buffer | null> {
        const href = url?.trim();
        if (!href || !/^https?:\/\//i.test(href)) return Promise.resolve(null);
        const kept = this.cache.get(href);
        if (kept && kept.until > this.now()) return kept.logo;
        const entry = { logo: this.load(href), until: this.now() + KEEP_MS };
        this.cache.set(href, entry);
        entry.logo.then((logo) => {
            if (!logo) entry.until = this.now() + RETRY_MS;
        });
        return entry.logo;
    }

    private async load(url: string): Promise<Buffer | null> {
        try {
            const res = await this.fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) return null;
            const data = Buffer.from(await res.arrayBuffer());
            return data.length <= MAX_BYTES && isLogoImage(data) ? drawableLogo(data) : null;
        } catch {
            // Unreachable or too slow: the letterhead goes without it
            return null;
        }
    }
}

export const recordLogos = new RecordLogos();
