import type { Response } from "express";

/** Sends a PDF for the browser to show, named for saving. */
export function sendPdf(res: Response, buffer: Buffer, fileName: string, download = false) {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader("Cache-Control", "no-store");
    res.end(buffer);
}
