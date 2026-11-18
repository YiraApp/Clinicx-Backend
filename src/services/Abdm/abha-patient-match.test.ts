import { test } from "node:test";
import assert from "node:assert/strict";
import { genderLetter, MAX_MATCHES, nameAgreement, profileDateToSql, rankPatientMatches, type PatientCandidateRow } from "./abha-patient-match.js";
import { toProfileSummary } from "./abha-enrolment.service.js";

// Made-up people only.
const profile = toProfileSummary({ firstName: "Meera", middleName: "Devi", lastName: "Rao", dob: "14-02-1988", gender: "F", mobile: "******4321" });

const row = (userId: string, firstName: string | null, lastName: string | null, phone: string | null, extra: Partial<PatientCandidateRow> = {}): PatientCandidateRow => ({
    userId, firstName, lastName, dateOfBirth: "1988-02-14", gender: "F", phone, email: null, relation: null,
    isPrimary: true, bloodGroup: null, tokenNumber: null, registeredHere: false, primary: null, ...extra,
});

test("the profile's DD-MM-YYYY becomes a SQL date only when it is a real day", () => {
    assert.equal(profileDateToSql("14-02-1988"), "1988-02-14");
    assert.equal(profileDateToSql("29-02-2000"), "2000-02-29");
    assert.equal(profileDateToSql("29-02-2001"), null, "not a leap year");
    assert.equal(profileDateToSql("31-04-1990"), null);
    assert.equal(profileDateToSql("1988"), null, "a year alone is too little to search with");
    assert.equal(profileDateToSql("1988-02-14"), null);
    assert.equal(profileDateToSql(null), null);
});

test("M, F and O (for O or T) narrow the search; U or none read every record", () => {
    assert.equal(genderLetter("F"), "F");
    assert.equal(genderLetter("male"), "M");
    assert.equal(genderLetter("O"), "O");
    assert.equal(genderLetter("Transgender"), "O", "the form calls T Other too");
    assert.equal(genderLetter("U"), null);
    assert.equal(genderLetter("T"), "O");
    assert.equal(genderLetter(""), null);
    assert.equal(genderLetter(null), null);
});

test("a name is the same in any order or spacing, close with a part missing, an initial or a slip", () => {
    assert.equal(nameAgreement(profile, { firstName: "Meera Devi", lastName: "Rao" }), "same", "the form keeps the middle name in the first name");
    assert.equal(nameAgreement(profile, { firstName: "RAO", lastName: "meera devi" }), "same");
    assert.equal(nameAgreement(profile, { firstName: "MeeraDevi", lastName: "Rao" }), "same");
    assert.equal(nameAgreement(profile, { firstName: "Meera", lastName: "Rao" }), "close", "no middle name");
    assert.equal(nameAgreement(profile, { firstName: "Meera", lastName: null }), "close", "first name only");
    assert.equal(nameAgreement(profile, { firstName: "M.", lastName: "Rao" }), "close", "an initial");
    assert.equal(nameAgreement(profile, { firstName: "Meeraa", lastName: "Rao" }), "close", "one letter in five");
    assert.equal(nameAgreement(profile, { firstName: "Kavya", lastName: "Rao" }), "different");
    assert.equal(nameAgreement(profile, { firstName: "M", lastName: "R" }), "different", "initials alone say nothing");
    assert.equal(nameAgreement(profile, { firstName: "Rao", lastName: "Rao" }), "different", "one word of theirs cannot stand for two of ours");
    assert.equal(nameAgreement(profile, { firstName: null, lastName: "" }), "different");
    const fullOnly = toProfileSummary({ name: "Meera Devi Rao" });
    assert.equal(nameAgreement(fullOnly, { firstName: "Meera", lastName: "Rao" }), "close");
});

test("records are offered on a same or close name, or a different name on the same mobile, best first", () => {
    const matches = rankPatientMatches([
        row("a", "Kavya", "Rao", "9000000000"),
        row("b", "Meera", "Rao", "9000000000"),
        row("c", "Meera Devi", "Rao", "98765 04321"),
        row("d", "Kavya", "Rao", "+91-98765-04321"),
        row("e", "Meera Devi", "Rao", null, { registeredHere: true }),
        row("C", "Meera Devi", "Rao", "98765 04321"),
    ], profile, "4321");
    assert.deepEqual(
        matches.map((m) => [m.id, m.match.name, m.match.mobileLast4]),
        [["c", "same", true], ["e", "same", false], ["b", "close", false], ["d", "different", true]],
        "the name weighs more than a mobile a family shares; a different name on another number is left out; one record is offered once",
    );
    assert.equal(matches[1]!.isRegisteredAtHospital, true);
});

test("without the mobile's last 4 digits only the name decides, and the list is capped", () => {
    const many = Array.from({ length: MAX_MATCHES + 5 }, (_, i) => row(`id-${i}`, "Meera", "Rao", "9000000000"));
    assert.equal(rankPatientMatches(many, profile, null).length, MAX_MATCHES);
    assert.deepEqual(rankPatientMatches([row("x", "Kavya", "Rao", "9876504321")], profile, null), []);
});

test("a family member keeps the primary record it hangs off, for Register & Book", () => {
    const primary = { id: "p", name: "Ravi Rao", firstName: "Ravi", lastName: "Rao", phone: "9000000000", email: "", gender: "M", dateOfBirth: null, relation: "Self", isPrimary: true };
    const [match] = rankPatientMatches([row("m", "Meera", "Rao", "9000000000", { isPrimary: false, relation: "Wife", primary })], profile, "4321");
    assert.equal(match!.primary, primary);
    assert.equal(match!.relation, "Wife");
});

test("an initial never takes the word a whole word needs: every pairing is tried", () => {
    const abha = (firstName: string, lastName: string) => toProfileSummary({ firstName, lastName });
    assert.equal(nameAgreement(abha("R", "Ramesh"), { firstName: "Ramesh", lastName: "Raman" }), "close");
    assert.equal(nameAgreement(abha("Ramesh", "Raghavan"), { firstName: "R.", lastName: "Ramesh" }), "close");
    assert.equal(nameAgreement(abha("Kumar", "Krishnan"), { firstName: "K", lastName: "Kumar" }), "close");
    assert.equal(nameAgreement(toProfileSummary({ firstName: "Senthil", middleName: "Kumar", lastName: "Subramanian" }), { firstName: "S", lastName: "Senthil Kumar" }), "close");
    // Initials on both sides with no whole word agreeing are two different names.
    assert.equal(nameAgreement(abha("K", "Ramesh"), { firstName: "Kiran", lastName: "R" }), "different");
});

test("a record whose recorded gender differs is never offered; one with none says so", () => {
    const male = toProfileSummary({ firstName: "Meera", lastName: "Rao", dob: "14-02-1988", gender: "M" });
    assert.deepEqual(rankPatientMatches([row("f", "Meera", "Rao", null, { gender: "Female" })], male, null), []);
    const transgender = toProfileSummary({ firstName: "Meera", lastName: "Rao", dob: "14-02-1988", gender: "T" });
    assert.deepEqual(rankPatientMatches([row("f", "Meera", "Rao", null, { gender: "Female" }), row("o", "Meera", "Rao", null, { gender: "Other" })], transgender, null).map((m) => m.id), ["o"]);
    const [blank] = rankPatientMatches([row("n", "Meera Devi", "Rao", null, { gender: null })], profile, null);
    assert.equal(blank!.match.gender, "not-recorded");
});

test("an ABHA with no gender (U or none) compares none, so no record is said to share it", () => {
    for (const gender of ["U", undefined]) {
        const noGender = toProfileSummary({ firstName: "Meera", lastName: "Rao", dob: "14-02-1988", ...(gender ? { gender } : {}) });
        const matches = rankPatientMatches([row("m", "Meera", "Rao", null, { gender: "Male" }), row("f", "Meera", "Rao", null, { gender: "Female" })], noGender, null);
        assert.deepEqual(matches.map((m) => m.match.gender), ["not-compared", "not-compared"], String(gender));
    }
});
