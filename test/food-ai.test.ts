import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServing, servingFactor } from "../src/services/Diet/food-ai.service.js";

test("reads the count and grams of a serving", () => {
    assert.deepEqual(parseServing("2 pieces (80g)"), { count: 2, grams: 80 });
    assert.deepEqual(parseServing("1 glass (250ml)"), { count: 1, grams: 250 });
    assert.deepEqual(parseServing("1 katori"), { count: 1, grams: null });
    assert.deepEqual(parseServing(null), { count: null, grams: null });
});

test("scales a database serving to the amount asked", () => {
    const idli = { count: 2, grams: 80 };
    assert.deepEqual(servingFactor({ quantity: 4, unit: "pieces", grams: null }, idli), { factor: 2, grams: 160 });
    assert.deepEqual(servingFactor({ quantity: 1, unit: "serving", grams: 120 }, idli), { factor: 1.5, grams: 120 });
    assert.deepEqual(servingFactor({ quantity: 160, unit: "g", grams: null }, idli), { factor: 2, grams: 160 });
    // no weight known: one serving per unit asked
    assert.deepEqual(servingFactor({ quantity: 1, unit: "bowl", grams: null }, { count: null, grams: null }), { factor: 1, grams: null });
});
