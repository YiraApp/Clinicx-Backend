import { createHash, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { abdmGatewayService, type AbdmGatewayService } from "../abdm-gateway.service.js";
import { byHiType, CareContextCatalog, patientReference } from "./care-contexts.js";
import type { Hip, M2Store, PatientProfile } from "./m2-store.js";

/**
 * User-initiated linking: the patient finds this facility in their PHR app (discover), picks
 * records to link (init, answered with a link reference and an OTP we text them) and confirms
 * with the OTP (confirm). Each ABDM request is answered on its on-* call with the request's id.
 * No code is published for a wrong or expired OTP: ABDM-9999 with a message the patient reads.
 */

type Gateway = Pick<AbdmGatewayService, "call">;
export interface OtpSender {
    sendOTP(to: string, otp: string): Promise<unknown>;
}

const OTP_MINUTES = 10;
const MAX_ATTEMPTS = 3;

type Identifier = { type?: string; value?: string };

const normalizeName = (name: string): string[] =>
    name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);

const levenshtein = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0]!;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j]!;
            row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length]!;
};

/**
 * NHA's discovery rule: on a mobile match, a fuzzy match on the person. Every name part the
 * request gives must be close to a part of ours (one edit in five letters), and gender and year
 * of birth, when both sides have them, must agree (a year either way, for a typed date of birth).
 */
export const looksLikeSamePerson = (ours: PatientProfile, theirs: { name?: string; gender?: string; yearOfBirth?: number }): boolean => {
    const a = normalizeName(ours.name);
    const b = normalizeName(theirs.name ?? "");
    if (!a.length || !b.length) return false;
    const close = (x: string, y: string) => levenshtein(x, y) <= Math.floor(Math.max(x.length, y.length) / 5);
    if (!b.every((part) => a.some((mine) => close(mine, part)))) return false;
    const gender = (ours.gender ?? "").trim().charAt(0).toUpperCase();
    if (gender && theirs.gender && gender !== theirs.gender.trim().charAt(0).toUpperCase()) return false;
    const year = Number(ours.birthDate?.slice(0, 4));
    if (Number.isInteger(year) && year > 1900 && theirs.yearOfBirth && Math.abs(year - Number(theirs.yearOfBirth)) > 1) return false;
    return true;
};

const otpHash = (linkRef: string, otp: string): string => createHash("sha256").update(`${linkRef}:${otp}`).digest("hex");

export class PatientLinkingService {
    constructor(
        private readonly store: M2Store,
        private readonly catalog: CareContextCatalog,
        private readonly sms: OtpSender,
        private readonly gateway: Gateway = abdmGatewayService,
        private readonly now: () => Date = () => new Date(),
        private readonly newOtp: () => string = () => String(randomInt(100000, 1000000)),
    ) {}

    private reply(hip: Hip, operation: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
        return this.gateway.call({
            operation, host: "gateway", method: "POST", path,
            headers: { "X-HIP-ID": hip.id, ...extraHeaders },
            body,
        });
    }

    /** The patient the request describes, and how they were matched; null when no one (or more than one) matches. */
    async match(hip: Hip, patient: any): Promise<{ profile: PatientProfile; matchedBy: string } | null> {
        const { hospitalId } = hip;
        const verified: Identifier[] = Array.isArray(patient?.verifiedIdentifiers) ? patient.verifiedIdentifiers : [];
        const unverified: Identifier[] = Array.isArray(patient?.unverifiedIdentifiers) ? patient.unverifiedIdentifiers : [];
        const value = (list: Identifier[], type: string) => list.find((i) => i?.type === type && i.value)?.value;
        const demographics = { name: patient?.name, gender: patient?.gender, yearOfBirth: patient?.yearOfBirth };
        const one = (list: PatientProfile[]) => (list.length === 1 ? list[0]! : null);

        const abhaAddress = value(verified, "ABHA_ADDRESS") ?? (typeof patient?.id === "string" && patient.id.includes("@") ? patient.id : undefined);
        if (abhaAddress) {
            const found = one(await this.store.patientsAt(hospitalId, { abhaAddress }));
            if (found) return { profile: found, matchedBy: "ABHA_ADDRESS" };
        }
        const abhaNumber = value(verified, "ABHA_NUMBER");
        if (abhaNumber) {
            const found = one(await this.store.patientsAt(hospitalId, { abhaNumber }));
            if (found) return { profile: found, matchedBy: "ABHA_NUMBER" };
        }
        const mr = value(verified, "MR") ?? value(unverified, "MR");
        if (mr) {
            const found = one((await this.store.patientsAt(hospitalId, { userId: mr })).filter((p) => looksLikeSamePerson(p, demographics)));
            if (found) return { profile: found, matchedBy: "MR" };
        }
        const mobile = value(verified, "MOBILE");
        if (mobile) {
            const found = one((await this.store.patientsAt(hospitalId, { mobile })).filter((p) => looksLikeSamePerson(p, demographics)));
            if (found) return { profile: found, matchedBy: "MOBILE" };
        }
        return null;
    }

    /** discover → on-discover: the matched patient's care contexts not linked yet, by HI type. */
    async onDiscover(hip: Hip, requestId: string, headers: Record<string, string>, body: any): Promise<void> {
        const transactionId = body?.transactionId;
        const answer = (content: object) => this.reply(
            hip,
            "user-initiated-linking/v3/patient/care-context/on-discover",
            "/api/hiecm/user-initiated-linking/v3/patient/care-context/on-discover",
            { transactionId, ...content, response: { requestId } },
            // The specification lists X-HIU-ID on this reply: the requester's, or ours (registered as HIU too)
            { "X-HIU-ID": headers["x-hiu-id"] || hip.id },
        );

        const matched = await this.match(hip, body?.patient);
        if (!matched) {
            await answer({ error: { code: "ABDM-9999", message: "No matching patient record was found at this facility." } });
            return;
        }
        const contexts = (await this.catalog.refresh(hip, matched.profile.userId)).filter((c) => c.linkStatus !== "linked" && c.hiTypes.length);
        if (!contexts.length) {
            await answer({ error: { code: "ABDM-1012", message: "No records to link were found at this facility." } });
            return;
        }
        await answer({ patient: byHiType(patientReference(matched.profile.userId), matched.profile.name, contexts), matchedBy: [matched.matchedBy] });
    }

    /** init → on-init: checks the picked care contexts are the patient's and unlinked, then texts an OTP. */
    async onLinkInit(hip: Hip, requestId: string, body: any): Promise<void> {
        const transactionId = body?.transactionId;
        const answer = (content: object) => this.reply(
            hip,
            "user-initiated-linking/v3/link/care-context/on-init",
            "/api/hiecm/user-initiated-linking/v3/link/care-context/on-init",
            { transactionId, ...content, response: { requestId } },
        );
        const fail = (code: string, message: string) => answer({ error: { code, message } });

        const entries: any[] = Array.isArray(body?.patient) ? body.patient : [];
        const patientRefs = [...new Set(entries.map((e) => String(e?.referenceNumber ?? "")))];
        if (patientRefs.length !== 1 || !patientRefs[0]) return void (await fail("ABDM-1060", "Invalid patient reference number."));
        const refs = [...new Set(entries.flatMap((e) => (Array.isArray(e?.careContexts) ? e.careContexts : []).map((c: any) => String(c?.referenceNumber ?? ""))))].filter(Boolean);
        if (!refs.length) return void (await fail("ABDM-1057", "No care contexts were chosen."));

        const patient = (await this.store.patientsAt(hip.hospitalId, { userId: patientRefs[0] }))[0];
        if (!patient) return void (await fail("ABDM-1060", "Invalid patient reference number."));
        const contexts = await this.store.careContextsByRefs(hip.id, refs);
        if (contexts.length !== refs.length || contexts.some((c) => c.patientUserId !== patientReference(patient.userId))) {
            return void (await fail("ABDM-1057", "Invalid care contexts."));
        }
        if (contexts.some((c) => c.linkStatus === "linked")) return void (await fail("ABDM-1056", "These care contexts are already linked."));
        const phone = (patient.phone ?? "").replace(/\D/g, "").slice(-10);
        if (phone.length !== 10) return void (await fail("ABDM-9999", "The facility has no mobile number to send the OTP to."));

        const linkRefNumber = randomUUID();
        const otp = this.newOtp();
        const expiresAt = new Date(this.now().getTime() + OTP_MINUTES * 60_000);
        try {
            await this.sms.sendOTP(phone, otp);
        } catch (error: any) {
            console.warn(`[ABDM] link OTP could not be sent: ${error?.message}`);
            return void (await fail("ABDM-9999", "The OTP could not be sent. Please try again."));
        }
        await this.store.createLinkRequest({
            linkRefNumber, transactionId: String(transactionId ?? ""), hipId: hip.id, patientUserId: patientReference(patient.userId),
            abhaAddress: String(body?.abhaAddress ?? patient.abhaAddress ?? ""), careContextRefs: refs,
            otpHash: otpHash(linkRefNumber, otp), otpExpiresAt: expiresAt, attempts: 0, status: "pending",
        });
        await answer({
            link: {
                referenceNumber: linkRefNumber,
                authenticationType: "DIRECT",
                meta: { communicationMedium: "MOBILE", communicationHint: "OTP", communicationExpiry: expiresAt.toISOString() },
            },
        });
    }

    /** confirm → on-confirm: the OTP is checked (three tries, ten minutes) and the care contexts linked. */
    async onLinkConfirm(hip: Hip, requestId: string, body: any): Promise<void> {
        const answer = (content: object) => this.reply(
            hip,
            "user-initiated-linking/v3/link/care-context/on-confirm",
            "/api/hiecm/user-initiated-linking/v3/link/care-context/on-confirm",
            { ...content, response: { requestId } },
        );
        const fail = (code: string, message: string) => answer({ error: { code, message } });

        const linkRef = String(body?.confirmation?.linkRefNumber ?? "");
        const token = String(body?.confirmation?.token ?? "");
        const request = linkRef ? await this.store.linkRequest(linkRef) : null;
        if (!request || request.hipId !== hip.id) return void (await fail("ABDM-1056", "Invalid link reference number."));
        if (request.status !== "pending") return void (await fail("ABDM-9999", "This link request is no longer open. Please start again."));
        if (this.now() > request.otpExpiresAt) {
            await this.store.updateLinkRequest(linkRef, { status: "expired" });
            return void (await fail("ABDM-9999", "The OTP has expired. Please start again."));
        }
        const given = Buffer.from(otpHash(linkRef, token), "hex");
        const expected = Buffer.from(request.otpHash, "hex");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            const attempts = request.attempts + 1;
            await this.store.updateLinkRequest(linkRef, { attempts, status: attempts >= MAX_ATTEMPTS ? "failed" : "pending" });
            return void (await fail("ABDM-9999", attempts >= MAX_ATTEMPTS ? "The OTP was wrong three times. Please start again." : "The OTP is incorrect."));
        }

        const contexts = await this.store.careContextsByRefs(hip.id, request.careContextRefs);
        for (const c of contexts) {
            await this.store.setLinkState([c.id], {
                linkStatus: "linked", linkedVia: "patient", linkedAbhaAddress: request.abhaAddress || null, linkedAt: this.now(), notifiedHiTypes: c.hiTypes, lastError: null,
            });
        }
        await this.store.updateLinkRequest(linkRef, { status: "linked" });
        const patient = await this.store.patient(request.patientUserId);
        await answer({ patient: byHiType(request.patientUserId, patient?.name ?? "Patient", contexts) });
    }
}
