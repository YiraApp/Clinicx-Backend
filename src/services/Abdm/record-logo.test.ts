import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { RecordLogos, drawableLogo, isLogoImage, opaquePng } from "./record-logo.js";

/** The parts of a PNG: its header fields and its pixel rows, inflated. */
const readPng = (png: Buffer) => {
    let at = 8, ihdr: Buffer | null = null;
    const idat: Buffer[] = [];
    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString("latin1", at + 4, at + 8);
        if (type === "IHDR") ihdr = png.subarray(at + 8, at + 8 + length);
        if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
        at += 12 + length;
    }
    return { width: ihdr!.readUInt32BE(0), height: ihdr!.readUInt32BE(4), depth: ihdr![8], colorType: ihdr![9], rows: inflateSync(Buffer.concat(idat)) };
};

/** A 2×1 RGBA PNG: a transparent pixel, then an opaque red one. */
const rgbaPng = (): Buffer => {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (b: Buffer) => {
        let c = 0xffffffff;
        for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "latin1");
        data.copy(out, 8);
        out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    // Row filter 1 (Sub), as encoders use: the second pixel is stored as its difference from the first
    const row = Buffer.from([1, 0, 0, 0, 0, 255, 0, 0, 255]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(row)), chunk("IEND", Buffer.alloc(0))]);
};

test("a PNG with transparency becomes an opaque RGB PNG, laid over white", () => {
    const out = opaquePng(rgbaPng())!;
    const png = readPng(out);
    assert.deepEqual([png.width, png.height, png.depth, png.colorType], [2, 1, 8, 2], "8-bit RGB, same size");
    assert.deepEqual([...png.rows], [0, 255, 255, 255, 255, 0, 0], "the transparent pixel white, the red one red");
    assert.ok(isLogoImage(out));
});

test("the clinic's logo file is made opaque at its own size", () => {
    const stored = readFileSync("public/images/hospital_logo.png");
    const before = readPng(stored);
    const after = readPng(drawableLogo(stored)!);
    assert.deepEqual([after.width, after.height, after.colorType], [before.width, before.height, 2]);
});

test("a JPEG is used as it is; anything that isn't a PNG or JPEG gives no logo", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    assert.equal(drawableLogo(jpeg), jpeg);
    assert.equal(opaquePng(Buffer.from("not an image")), null);
    assert.equal(isLogoImage(Buffer.from("<svg/>")), false);
});

test("a logo is fetched once and kept; a failed fetch gives none and is tried again later", async () => {
    let clock = 0;
    const calls: string[] = [];
    let answer: () => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }> = async () => {
        throw new Error("offline");
    };
    // No fallback logo here: what is fetched is what is given
    const logos = new RecordLogos(async (url) => {
        calls.push(url);
        return answer();
    }, () => clock, null);
    const url = "https://storage.example.test/logos/12.png";

    assert.equal(await logos.get(url), null, "unreachable: no logo");
    assert.equal(await logos.get(url), null);
    assert.equal(calls.length, 1, "not fetched again straight away");

    const png = rgbaPng();
    answer = async () => ({ ok: true, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) as ArrayBuffer });
    clock += 3 * 60_000;
    const logo = await logos.get(url);
    assert.equal(calls.length, 2, "tried again after a while");
    assert.equal(readPng(logo!).colorType, 2, "made opaque");
    await logos.get(url);
    assert.equal(calls.length, 2, "kept");

    assert.equal(await logos.get(null), null);
    assert.equal(await logos.get("/images/logo.png"), null, "only a web address is fetched");
    assert.equal(calls.length, 2);
});

test("a page that isn't an image, or one too large, gives no logo", async () => {
    const page = Buffer.from("<html>not found</html>");
    const logos = new RecordLogos(async () => ({ ok: true, arrayBuffer: async () => page.buffer.slice(page.byteOffset, page.byteOffset + page.length) as ArrayBuffer }), undefined, null);
    assert.equal(await logos.get("https://storage.example.test/a.png"), null);
    const failing = new RecordLogos(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }), undefined, null);
    assert.equal(await failing.get("https://storage.example.test/b.png"), null);
    const huge = Buffer.concat([rgbaPng(), Buffer.alloc(1_600_000)]);
    const large = new RecordLogos(async () => ({ ok: true, arrayBuffer: async () => huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.length) as ArrayBuffer }), undefined, null);
    assert.equal(await large.get("https://storage.example.test/c.png"), null);
});

test("a hospital without a logo gets the one the clinic's prescription PDF falls back to", async () => {
    let calls = 0;
    const logos = new RecordLogos(async () => {
        calls++;
        throw new Error("offline");
    });
    const fallback = await logos.get(null);
    assert.ok(fallback, "the bundled logo");
    assert.equal(readPng(fallback).colorType, 2, "made opaque");
    assert.deepEqual(await logos.get("https://storage.example.test/missing.png"), fallback, "and when the hospital's can't be fetched");
    assert.equal(calls, 1);
    assert.equal(await new RecordLogos(undefined, undefined, "public/images/no-such-logo.png").get(null), null, "no fallback file: no logo");
});
