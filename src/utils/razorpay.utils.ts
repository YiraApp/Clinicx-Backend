/**
 * Razorpay helpers shared by appointment and lab package payments.
 *
 * The Razorpay SDK rejects with a plain object ({ statusCode, error: { code, description } }),
 * not an Error, so `error.message` is empty and callers used to show "Something went wrong.".
 */

/** The readable reason inside a Razorpay SDK rejection, or null when it isn't one. */
export function razorpayErrorDetail(error: any): { statusCode: number | null; description: string } | null {
    if (!error || typeof error !== "object" || error instanceof Error) return null;
    const description = error?.error?.description || error?.error?.reason || error?.description;
    const statusCode = Number(error?.statusCode) || null;
    if (!description && !statusCode) return null;
    return { statusCode, description: String(description || "Unknown Razorpay error") };
}

/**
 * Turns a failed `orders.create` into an Error the patient can read, logging Razorpay's own
 * reason for the team. A 401 means the hospital's saved keys are wrong or were regenerated.
 */
export function razorpayOrderError(error: any, context: string): Error {
    const detail = razorpayErrorDetail(error);
    if (!detail) return error instanceof Error ? error : new Error("Could not start the payment. Please try again.");
    console.error(`[Razorpay] ${context}: HTTP ${detail.statusCode ?? "?"} ${detail.description}`);
    if (detail.statusCode === 401) {
        return new Error("Online payment isn't working at this hospital right now. Please try again later or contact the hospital.");
    }
    if (detail.statusCode === 400) return new Error(`The payment could not be started: ${detail.description}`);
    return new Error("The payment service is not responding. Please try again in a few minutes.");
}

/**
 * Checks a key pair with Razorpay before it is saved. Returns the problem to show the admin,
 * or null when the keys work. A network failure is not treated as bad keys.
 */
export async function razorpayKeyProblem(keyId: string, keySecret: string): Promise<string | null> {
    const id = String(keyId || "").trim();
    const secret = String(keySecret || "").trim();
    if (!id || !secret) return null;
    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(id)) {
        return "The Razorpay key ID should look like rzp_live_... or rzp_test_....";
    }
    try {
        const response = await fetch("https://api.razorpay.com/v1/orders?count=1", {
            headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401) {
            return "Razorpay rejected this key ID and secret. Copy both again from the Razorpay dashboard (Settings → API Keys); a regenerated key needs its new secret.";
        }
        return null;
    } catch {
        return null;
    }
}
