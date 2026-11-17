import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCollectionAddress, readCollectionAddress, addressText, distinctAddresses } from "./lab-address.js";
import { parseAppOptions, DEFAULT_APP_OPTIONS, slotInstant } from "./lab-slot.service.js";
import { labPackageOrderService } from "./lab-package-order.service.js";
import type { LabPackageOrder } from "../../models/LabPackages/lab-package-order.model.js";

const home = { line1: " 12  MG Road ", line2: "Indiranagar", landmark: "", city: "Bengaluru", state: "Karnataka", pincode: "560 038" };

test("a collection address needs the street, the city and a 6-digit pincode, and is tidied", () => {
    assert.deepEqual(parseCollectionAddress(home), {
        line1: "12 MG Road", line2: "Indiranagar", landmark: "", city: "Bengaluru", state: "Karnataka", pincode: "560038",
    });
    assert.throws(() => parseCollectionAddress(null), /Choose the address/);
    assert.throws(() => parseCollectionAddress({ ...home, line1: "  " }), /house number and street/);
    assert.throws(() => parseCollectionAddress({ ...home, city: "" }), /city/);
    assert.throws(() => parseCollectionAddress({ ...home, pincode: "5600" }), /6-digit pincode/);
});

test("a stored address reads back, and a damaged one reads as none", () => {
    const stored = JSON.stringify(parseCollectionAddress(home));
    assert.equal(readCollectionAddress(stored)?.pincode, "560038");
    assert.equal(readCollectionAddress("not json"), null);
    assert.equal(readCollectionAddress(null), null);
    assert.equal(addressText(parseCollectionAddress(home)), "12 MG Road, Indiranagar, Bengaluru, Karnataka 560038");
});

test("saved addresses that differ only in case or spacing are listed once, the first kept", () => {
    const a = parseCollectionAddress(home);
    const b = parseCollectionAddress({ ...home, line1: "12 mg road" });
    const c = parseCollectionAddress({ ...home, pincode: "560001" });
    const list = distinctAddresses([{ label: "Home", address: a }, { label: "Used before", address: b }, { label: "Used before", address: c }]);
    assert.deepEqual(list.map((x) => x.label), ["Home", "Used before"]);
    assert.equal(list[1].address.pincode, "560001");
});

test("the app switches must be true or false, and rescheduling is off whenever slots are", () => {
    assert.deepEqual(parseAppOptions({ slotsEnabled: true, rescheduleEnabled: false, collectAddress: true }),
        { slotsEnabled: true, rescheduleEnabled: false, collectAddress: true });
    assert.deepEqual(parseAppOptions({ slotsEnabled: false, rescheduleEnabled: true, collectAddress: false }),
        { slotsEnabled: false, rescheduleEnabled: false, collectAddress: false });
    assert.throws(() => parseAppOptions({ slotsEnabled: "yes", rescheduleEnabled: true, collectAddress: false }), /slotsEnabled/);
    assert.throws(() => parseAppOptions(undefined), /slotsEnabled/);
    assert.deepEqual(DEFAULT_APP_OPTIONS, { slotsEnabled: true, rescheduleEnabled: true, collectAddress: false });
});

const order = (fields: Partial<LabPackageOrder>) => ({ Status: "Paid", RescheduleCount: 0, ...fields }) as LabPackageOrder;
const now = new Date("2026-11-06T04:30:00Z"); // 10:00 India time
const booked = order({ PreferredDate: "2026-11-08", SlotStart: "10:00", SlotEnd: "11:00" });

test("a paid order's slot can be chosen and moved by default, until 5 hours before it", () => {
    const state = labPackageOrderService.slotState(booked, now);
    assert.equal(state.canChangeSlot, true);
    assert.equal(state.slotsEnabled, true);
    assert.equal(state.rescheduleEnabled, true);
    assert.deepEqual(state.slotChangeUntil, new Date(slotInstant("2026-11-08", "10:00").getTime() - 5 * 3600000));
});

test("with slots off the hospital fixes the time: nothing can be chosen in the app", () => {
    const options = { slotsEnabled: false, rescheduleEnabled: false, collectAddress: false };
    const state = labPackageOrderService.slotState(order({}), now, options);
    assert.equal(state.canChangeSlot, false);
    assert.equal(state.slotsEnabled, false);
    assert.match(state.slotLockedReason!, /hospital will call you/);
    assert.equal(labPackageOrderService.slotState(booked, now, options).slotChangeUntil, null);
});

test("with rescheduling off a slot can be chosen once, then not moved in the app", () => {
    const options = { slotsEnabled: true, rescheduleEnabled: false, collectAddress: false };
    assert.equal(labPackageOrderService.slotState(order({}), now, options).canChangeSlot, true);
    const state = labPackageOrderService.slotState(booked, now, options);
    assert.equal(state.canChangeSlot, false);
    assert.match(state.slotLockedReason!, /doesn't allow changing the slot/);
    assert.equal(state.slotChangeUntil, null);
});

test("an unpaid, cancelled or collected order says so before any app switch", () => {
    const off = { slotsEnabled: false, rescheduleEnabled: false, collectAddress: false };
    assert.match(labPackageOrderService.slotState(order({ Status: "PaymentPending" }), now, off).slotLockedReason!, /Pay for the order/);
    assert.match(labPackageOrderService.slotState(order({ Status: "Cancelled" }), now, off).slotLockedReason!, /cancelled/);
    assert.match(labPackageOrderService.slotState(order({ Status: "SampleCollected" }), now, off).slotLockedReason!, /already collected/);
});

test("Razorpay's rejections (plain objects) become readable errors", async () => {
    const { razorpayError } = await import("./lab-package-order.service.js");
    const quiet = console.error;
    console.error = () => {};
    try {
        assert.match(razorpayError({ statusCode: 401, error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }).message, /refused the hospital's payment keys/);
        assert.equal(razorpayError({ statusCode: 400, error: { description: "The amount must be atleast INR 1.00" } }).message,
            "Razorpay could not start the payment: The amount must be atleast INR 1.00");
        assert.match(razorpayError({}).message, /could not start the payment/);
        const own = new Error("network down");
        assert.equal(razorpayError(own), own);
    } finally {
        console.error = quiet;
    }
});
