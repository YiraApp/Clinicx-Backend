import { abdmM2Repository, abdmRecordOwners } from "../../../repositories/Abdm/abdm-m2.repository.js";
import { smsService } from "../../Common/sms.service.js";
import type { CallbackHandler } from "../abdm-callback.service.js";
import { abdmFacilities } from "../abdm-facilities.service.js";
import { AutoLinker } from "./auto-link.js";
import { CareContextCatalog } from "./care-contexts.js";
import { DataFlowService } from "./data-flow.js";
import { HipLinkingService } from "./hip-linking.js";
import { PatientLinkingService } from "./patient-linking.js";

/** M2 for every facility on this bridge, wired to the database, the gateway and the SMS service. */

export const careContextCatalog = new CareContextCatalog(abdmM2Repository);
export const hipLinkingService = new HipLinkingService(abdmM2Repository, careContextCatalog);
export const patientLinkingService = new PatientLinkingService(abdmM2Repository, careContextCatalog, smsService);
export const dataFlowService = new DataFlowService(abdmM2Repository);
export const autoLinker = new AutoLinker(abdmRecordOwners, abdmFacilities, hipLinkingService);

/** The facility a callback is for. The callback service let it through only for a known X-HIP-ID. */
const facility = async (headers: Record<string, string>) => {
    const found = await abdmFacilities.hipById(headers["x-hip-id"]);
    if (!found) throw new Error(`X-HIP-ID ${headers["x-hip-id"] || "(none)"} is no facility here`);
    return found;
};

const answerOnly: CallbackHandler = async ({ path, answers, body }) => {
    // Recorded on the exchange; an ERRORED acknowledgement is worth a line in the log too.
    if (body?.acknowledgement?.status === "ERRORED" || body?.error) {
        console.warn(`[ABDM] ${path} answered ${answers} with an error: ${body?.error?.message ?? "ERRORED"}`);
    }
};

/** What happens after each M2 callback is stored and acknowledged. */
export const m2CallbackHandlers: Record<string, CallbackHandler> = {
    "/api/v3/hip/token/on-generate-token": async ({ answers, headers, body }) => hipLinkingService.onLinkToken(await facility(headers), answers!, body),
    "/api/v3/link/on_carecontext": ({ answers, body }) => hipLinkingService.onLinkResult(answers!, body),
    "/api/v3/links/context/on-notify": answerOnly,
    "/api/v3/patients/sms/on-notify": answerOnly,
    "/api/v3/hip/patient/care-context/discover": async ({ requestId, headers, body }) => patientLinkingService.onDiscover(await facility(headers), requestId, headers, body),
    "/api/v3/hip/link/care-context/init": async ({ requestId, headers, body }) => patientLinkingService.onLinkInit(await facility(headers), requestId, body),
    "/api/v3/hip/link/care-context/confirm": async ({ requestId, headers, body }) => patientLinkingService.onLinkConfirm(await facility(headers), requestId, body),
    "/api/v3/consent/request/hip/notify": async ({ requestId, headers, body }) => dataFlowService.onConsentNotify(await facility(headers), requestId, body),
    "/api/v3/hip/health-information/request": async ({ requestId, headers, body }) => dataFlowService.onHealthInformationRequest(await facility(headers), requestId, body),
};
