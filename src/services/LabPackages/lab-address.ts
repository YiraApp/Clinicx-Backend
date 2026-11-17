/**
 * The address a lab sample is collected from, as the patient picks it in the app. Kept free of the
 * database so the rules can be tested on their own.
 */
export interface CollectionAddress {
    line1: string;
    line2: string;
    landmark: string;
    city: string;
    state: string;
    pincode: string;
}

const LIMITS: Record<keyof CollectionAddress, number> = { line1: 200, line2: 200, landmark: 150, city: 100, state: 100, pincode: 6 };

const clean = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The address as sent by the app: house and street, city and a 6-digit pincode are required. */
export function parseCollectionAddress(input: unknown): CollectionAddress {
    if (!input || typeof input !== "object") throw new Error("Choose the address where the sample will be collected.");
    const raw = input as Record<string, unknown>;
    const address: CollectionAddress = {
        line1: clean(raw.line1, LIMITS.line1),
        line2: clean(raw.line2, LIMITS.line2),
        landmark: clean(raw.landmark, LIMITS.landmark),
        city: clean(raw.city, LIMITS.city),
        state: clean(raw.state, LIMITS.state),
        pincode: String(raw.pincode ?? "").replace(/\D/g, ""),
    };
    if (!address.line1) throw new Error("Enter the house number and street of the collection address.");
    if (!address.city) throw new Error("Enter the city of the collection address.");
    if (address.pincode.length !== 6) throw new Error("Enter the 6-digit pincode of the collection address.");
    return address;
}

/** The stored address (JSON), or null when there is none or it cannot be read. */
export function readCollectionAddress(stored: string | null | undefined): CollectionAddress | null {
    if (!stored) return null;
    try {
        return parseCollectionAddress(JSON.parse(stored));
    } catch {
        return null;
    }
}

/** One line for lists and the order screen: "12 MG Road, Indiranagar, Near Metro, Bengaluru, Karnataka 560038". */
export function addressText(a: CollectionAddress): string {
    const place = [a.city, a.state].filter(Boolean).join(", ");
    return [a.line1, a.line2, a.landmark, `${place} ${a.pincode}`.trim()].filter(Boolean).join(", ");
}

/** Two addresses that differ only in case or spacing are the same address. */
export const addressKey = (a: CollectionAddress) => addressText(a).toLowerCase().replace(/[^a-z0-9]/g, "");

/** The patient's saved addresses: profile ones first, then recent orders', without repeats. */
export function distinctAddresses<T extends { address: CollectionAddress }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = addressKey(item.address);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
