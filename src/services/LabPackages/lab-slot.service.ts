import { In } from "typeorm/index.js";
import { AppDataSource } from "../../config/database.js";
import { LabSlotTiming } from "../../models/LabPackages/lab-slot-timing.model.js";
import { LabPackageSetting } from "../../models/LabPackages/lab-package-setting.model.js";
import { canManageHospital } from "../../utils/staff-access.js";
import { LabAccessError } from "./lab-access-error.js";

/** A patient can pick or move a slot until this many hours before it starts. */
export const RESCHEDULE_CUTOFF_HOURS = 5;
/** How many days ahead slots can be booked, today included. */
export const BOOKING_DAYS = 14;

/** Slot times are India time; the server may run in any time zone. */
const IST_OFFSET_MS = 330 * 60 * 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface SlotTiming {
    start: string;
    end: string;
}

/** What the patient app offers for a hospital's lab orders (Lab Packages → Settings). */
export interface LabAppOptions {
    /** Patients choose a visit slot in the app. Off: the hospital fixes the time with them. */
    slotsEnabled: boolean;
    /** Patients can move a chosen slot in the app. Only counts while slots are on. */
    rescheduleEnabled: boolean;
    /** Checkout asks for the address where the sample is collected. */
    collectAddress: boolean;
}

/** A hospital with no settings row: as before these options existed. */
export const DEFAULT_APP_OPTIONS: LabAppOptions = { slotsEnabled: true, rescheduleEnabled: true, collectAddress: false };

const toOptions = (row: LabPackageSetting | null | undefined): LabAppOptions => row
    ? { slotsEnabled: !!row.PatientSlots, rescheduleEnabled: !!row.PatientSlots && !!row.PatientReschedule, collectAddress: !!row.CollectAddress }
    : { ...DEFAULT_APP_OPTIONS };

/** The switches as sent by Settings; each must be true or false. */
export function parseAppOptions(input: unknown): LabAppOptions {
    const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const flag = (name: keyof LabAppOptions) => {
        if (typeof raw[name] !== "boolean") throw new Error(`Send ${name} as true or false.`);
        return raw[name] as boolean;
    };
    const slotsEnabled = flag("slotsEnabled");
    return { slotsEnabled, rescheduleEnabled: slotsEnabled && flag("rescheduleEnabled"), collectAddress: flag("collectAddress") };
}

/** Default for a hospital with no slot timings: 10 AM – 6 PM in one-hour slots. */
export const DEFAULT_SLOT_TIMINGS: SlotTiming[] = Array.from({ length: 8 }, (_, i) => ({
    start: `${String(10 + i).padStart(2, "0")}:00`,
    end: `${String(11 + i).padStart(2, "0")}:00`
}));

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** "13:30" → "1:30 PM" */
export function to12h(time: string): string {
    const h = Number(time.slice(0, 2));
    const m = time.slice(3, 5);
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export const slotLabel = (start: string, end: string) => `${to12h(start)} – ${to12h(end)}`;

/** The moment a slot on a date (both India time) begins. */
export function slotInstant(date: string, time: string): Date {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5))) - IST_OFFSET_MS);
}

/** Today's date in India, "YYYY-MM-DD". */
export const indiaToday = (now = new Date()) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const addDays = (date: string, days: number) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
};

/** Slot timings as typed in Settings: valid times, start before end, no overlaps, sorted. */
export function parseSlotTimings(input: unknown): SlotTiming[] {
    if (!Array.isArray(input)) throw new Error("Send the slot timings as a list.");
    if (input.length > 48) throw new Error("A hospital can have up to 48 slots a day.");
    const slots = input.map((raw: any, i) => {
        const start = String(raw?.start ?? "").trim();
        const end = String(raw?.end ?? "").trim();
        if (!TIME.test(start) || !TIME.test(end)) throw new Error(`Slot ${i + 1}: enter times as HH:mm (24-hour), e.g. 10:00 and 11:00.`);
        if (minutes(end) <= minutes(start)) throw new Error(`Slot ${i + 1}: the end time must be after the start time.`);
        return { start, end };
    }).sort((a, b) => minutes(a.start) - minutes(b.start));
    for (let i = 1; i < slots.length; i++) {
        if (minutes(slots[i].start) < minutes(slots[i - 1].end)) {
            throw new Error(`${slotLabel(slots[i - 1].start, slots[i - 1].end)} and ${slotLabel(slots[i].start, slots[i].end)} overlap.`);
        }
    }
    return slots;
}

export class LabSlotService {
    private repo = AppDataSource.getRepository(LabSlotTiming);

    /** The hospital's slot timings, or the default 10 AM – 6 PM when it has set none. */
    async timings(hospitalId: number): Promise<{ slots: (SlotTiming & { label: string })[]; isDefault: boolean }> {
        const rows = await this.repo.find({ where: { HospitalId: hospitalId, IsActive: true } });
        const slots = rows.length > 0
            ? rows.map(r => ({ start: r.StartTime, end: r.EndTime })).sort((a, b) => minutes(a.start) - minutes(b.start))
            : DEFAULT_SLOT_TIMINGS;
        return { slots: slots.map(s => ({ ...s, label: slotLabel(s.start, s.end) })), isDefault: rows.length === 0 };
    }

    private async assertStaff(requesterId: string, hospitalId: number) {
        if (!(hospitalId > 0)) throw new Error("Choose a hospital.");
        if (!(await canManageHospital(requesterId, hospitalId))) {
            throw new LabAccessError("You do not have access to this hospital's lab settings.");
        }
    }

    async timingsForStaff(requesterId: string, hospitalId: number) {
        await this.assertStaff(requesterId, hospitalId);
        return {
            hospitalId,
            cutoffHours: RESCHEDULE_CUTOFF_HOURS,
            ...(await this.timings(hospitalId)),
            appOptions: await this.appOptions(hospitalId)
        };
    }

    /** The hospital's app options, or the defaults when it has saved none. */
    async appOptions(hospitalId: number): Promise<LabAppOptions> {
        if (!(hospitalId > 0)) return { ...DEFAULT_APP_OPTIONS };
        return toOptions(await AppDataSource.getRepository(LabPackageSetting).findOne({ where: { HospitalId: hospitalId } }));
    }

    /** App options for several hospitals at once; every id asked for is in the map. */
    async appOptionsFor(hospitalIds: number[]): Promise<Map<number, LabAppOptions>> {
        const ids = Array.from(new Set(hospitalIds.map(Number).filter(id => id > 0)));
        const rows = ids.length ? await AppDataSource.getRepository(LabPackageSetting).find({ where: { HospitalId: In(ids) } }) : [];
        const byId = new Map(rows.map(r => [Number(r.HospitalId), r]));
        return new Map(ids.map(id => [id, toOptions(byId.get(id))]));
    }

    async saveAppOptions(requesterId: string, hospitalId: number, input: unknown) {
        await this.assertStaff(requesterId, hospitalId);
        const options = parseAppOptions(input);
        const repo = AppDataSource.getRepository(LabPackageSetting);
        await repo.save(repo.create({
            HospitalId: hospitalId,
            PatientSlots: options.slotsEnabled,
            PatientReschedule: options.rescheduleEnabled,
            CollectAddress: options.collectAddress,
            UpdatedAt: new Date(),
            UpdatedBy: requesterId
        }));
        return this.timingsForStaff(requesterId, hospitalId);
    }

    /** Replaces the hospital's slot timings; an empty list goes back to the default. */
    async saveTimings(requesterId: string, hospitalId: number, input: unknown) {
        await this.assertStaff(requesterId, hospitalId);
        const slots = parseSlotTimings(input);
        await AppDataSource.transaction(async (manager) => {
            await manager.delete(LabSlotTiming, { HospitalId: hospitalId });
            for (const s of slots) {
                await manager.save(LabSlotTiming, manager.create(LabSlotTiming, {
                    HospitalId: hospitalId, StartTime: s.start, EndTime: s.end, IsActive: true, CreatedAt: new Date(), CreatedBy: requesterId
                }));
            }
        });
        return this.timingsForStaff(requesterId, hospitalId);
    }

    /** Bookable slots for the next days: those starting at least the cutoff from now. */
    async bookableDays(hospitalId: number, now = new Date()) {
        const { slots, isDefault } = await this.timings(hospitalId);
        const earliest = now.getTime() + RESCHEDULE_CUTOFF_HOURS * 3600000;
        const today = indiaToday(now);
        const days = [];
        for (let i = 0; i < BOOKING_DAYS; i++) {
            const date = addDays(today, i);
            const open = slots.filter(s => slotInstant(date, s.start).getTime() >= earliest);
            if (open.length > 0) days.push({ date, slots: open });
        }
        return { cutoffHours: RESCHEDULE_CUTOFF_HOURS, isDefault, days };
    }

    /** Checks a chosen slot is one of the hospital's and still bookable; returns it with its end time. */
    async validateChoice(hospitalId: number, date: unknown, start: unknown, now = new Date()) {
        const day = String(date || "").slice(0, 10);
        const from = String(start || "").trim();
        if (!DATE.test(day)) throw new Error("Choose the visit date.");
        if (!TIME.test(from)) throw new Error("Choose a visit slot.");
        if (day > addDays(indiaToday(now), BOOKING_DAYS - 1)) throw new Error(`Slots can be booked up to ${BOOKING_DAYS} days ahead.`);
        const { slots } = await this.timings(hospitalId);
        const slot = slots.find(s => s.start === from);
        if (!slot) throw new Error("This slot is not offered at the hospital. Choose another one.");
        if (slotInstant(day, slot.start).getTime() < now.getTime() + RESCHEDULE_CUTOFF_HOURS * 3600000) {
            throw new Error(`Choose a slot at least ${RESCHEDULE_CUTOFF_HOURS} hours from now.`);
        }
        return { date: day, start: slot.start, end: slot.end };
    }
}

export const labSlotService = new LabSlotService();
