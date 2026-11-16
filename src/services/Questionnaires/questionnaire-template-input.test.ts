import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTemplate } from "./questionnaire-template-input.js";

const ok = (result: ReturnType<typeof cleanTemplate>) => {
    assert.ok(result.ok, result.ok ? "" : result.error);
    return result.value;
};
const error = (result: ReturnType<typeof cleanTemplate>) => {
    assert.equal(result.ok, false);
    return result.ok ? "" : result.error;
};

test("a template with a few kinds of question is cleaned up", () => {
    const value = ok(cleanTemplate({
        title: "  Knee pain follow-up ",
        description: "",
        questions: [
            { text: " How bad is the pain? ", typeCode: "rating", isRequired: true },
            { text: "Where?", typeCode: "MULTI_CHOICE", options: [" Front ", "Back", "", "Side"] },
            { text: "Steps walked today", typeCode: "NUMBER", minValue: "0", maxValue: 50000 },
            { text: "Anything else?", typeCode: "LONG_TEXT", minValue: 3 },
        ],
    }));
    assert.equal(value.title, "Knee pain follow-up");
    assert.equal(value.description, null);
    assert.equal(value.allowMultiple, true);
    assert.deepEqual(value.questions?.map((q) => q.typeCode), ["RATING", "MULTI_CHOICE", "NUMBER", "LONG_TEXT"]);
    assert.deepEqual(value.questions?.[0], { text: "How bad is the pain?", typeCode: "RATING", helpText: null, isRequired: true, options: [], minValue: 1, maxValue: 5 });
    assert.deepEqual(value.questions?.[1].options, ["Front", "Back", "Side"]);
    assert.deepEqual([value.questions?.[2].minValue, value.questions?.[2].maxValue], [0, 50000]);
    // Limits only apply to numbers.
    assert.equal(value.questions?.[3].minValue, null);
});

test("problems are named in plain words", () => {
    assert.equal(error(cleanTemplate({ title: " ", questions: [{ text: "Q", typeCode: "YES_NO" }] })), "Give the questionnaire a name.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [] })), "Add at least one question.");
    assert.equal(error(cleanTemplate({ title: "T" })), "Add at least one question.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "", typeCode: "YES_NO" }] })), "Question 1 has no text.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "Q", typeCode: "SLIDER" }] })), "Question 1: choose how it is answered.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "Q", typeCode: "DROPDOWN", options: ["Only one"] }] })), "Question 1 needs at least two options.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "Q", typeCode: "SINGLE_CHOICE", options: ["Yes", "yes"] }] })), 'Question 1: "yes" is listed twice.');
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "Q", typeCode: "NUMBER", minValue: 9, maxValue: 3 }] })), "Question 1: the lowest value can't be more than the highest.");
    assert.equal(error(cleanTemplate({ title: "T", questions: [{ text: "Q", typeCode: "NUMBER", minValue: "abc" }] })), "Question 1: the lowest and highest allowed values must be numbers.");
});

test("renaming alone needs no questions", () => {
    const value = ok(cleanTemplate({ title: "New name", allowMultiple: false }, false));
    assert.equal(value.questions, undefined);
    assert.equal(value.allowMultiple, false);
});
