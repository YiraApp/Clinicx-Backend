import { LOINC, UCUM, fhirDateTime, narrative, NRCES, ref, resourceId, type FhirResource } from "./fhir-common.js";
import type { VisitVitals, WellnessMeasurement } from "./fhir-sources.js";

/**
 * Measurements as Observations, with the LOINC codes and UCUM units of NRCES's wellness value sets
 * (ndhm-vital-signs, ndhm-body-measurement, ndhm-physical-activity, ndhm-general-assessment, IG 6.5.0).
 */

export type WellnessSection = "VitalSigns" | "BodyMeasurement" | "PhysicalActivity" | "GeneralAssessment";

interface Measure {
    section: WellnessSection;
    code: string;
    display: string;
    unit: string;
    ucum: string;
}

const MEASURES: Record<Exclude<WellnessMeasurement["kind"], "bloodPressure">, Measure> = {
    heartRate: { section: "VitalSigns", code: "8867-4", display: "Heart rate", unit: "beats/minute", ucum: "/min" },
    respiratoryRate: { section: "VitalSigns", code: "9279-1", display: "Respiratory rate", unit: "breaths/minute", ucum: "/min" },
    oxygenSaturation: { section: "VitalSigns", code: "2708-6", display: "Oxygen saturation in Arterial blood", unit: "%", ucum: "%" },
    // ndhm-vital-signs has this one temperature code; the unit says how it was measured.
    temperature: { section: "VitalSigns", code: "61008-9", display: "Body surface temperature", unit: "°C", ucum: "Cel" },
    height: { section: "BodyMeasurement", code: "8302-2", display: "Body height", unit: "cm", ucum: "cm" },
    weight: { section: "BodyMeasurement", code: "29463-7", display: "Body weight", unit: "kg", ucum: "kg" },
    bmi: { section: "BodyMeasurement", code: "39156-5", display: "Body mass index (BMI) [Ratio]", unit: "kg/m2", ucum: "kg/m2" },
    steps: { section: "PhysicalActivity", code: "55423-8", display: "Number of steps in unspecified time Pedometer", unit: "steps", ucum: "{steps}" },
    caloriesBurned: { section: "PhysicalActivity", code: "41981-2", display: "Calories burned", unit: "kcal", ucum: "kcal" },
    sleepHours: { section: "PhysicalActivity", code: "93832-4", display: "Sleep duration", unit: "h", ucum: "h" },
    bloodGlucose: { section: "GeneralAssessment", code: "2339-0", display: "Glucose [Mass/volume] in Blood", unit: "mg/dL", ucum: "mg/dL" },
    fluidIntakeLitres: { section: "GeneralAssessment", code: "8999-5", display: "Fluid intake oral Estimated", unit: "L", ucum: "L" },
};

const BLOOD_PRESSURE = { section: "VitalSigns" as const, code: "85354-9", display: "Blood pressure panel with all children optional" };

/** The wellness profile each section's entries carry. */
export const WELLNESS_PROFILES: Record<WellnessSection, string> = {
    VitalSigns: "ObservationVitalSigns",
    BodyMeasurement: "ObservationBodyMeasurement",
    PhysicalActivity: "ObservationPhysicalActivity",
    GeneralAssessment: "ObservationGeneralAssessment",
};

export const sectionOf = (m: WellnessMeasurement): WellnessSection =>
    m.kind === "bloodPressure" ? BLOOD_PRESSURE.section : MEASURES[m.kind].section;

const quantity = (value: number, unit: string, ucum: string) => ({ value, unit, system: UCUM, code: ucum });

const INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
const FLAGS = { L: "Low", N: "Normal", H: "High" } as const;

/** Whole years from [birthDate] (YYYY-MM-DD) to [at]; null without a birth date. */
const ageAt = (birthDate: unknown, at: Date): number | null => {
    const m = String(birthDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return at.getFullYear() - y - (at.getMonth() + 1 < mo || (at.getMonth() + 1 === mo && at.getDate() < d) ? 1 : 0);
};

/**
 * A blood pressure reading against the adult range (systolic 90–139, diastolic 60–89 mmHg: below is
 * low, 140/90 and above is high), as the reference range and interpretation a PHR app shows. Only for
 * adults: a child's range depends on age and height, so a child's reading is given without either.
 */
const bpComponent = (code: string, display: string, value: number, low: number, high: number, adult: boolean) => {
    const flag = value < low ? "L" : value > high ? "H" : "N";
    return {
        code: { coding: [{ system: LOINC, code, display }] },
        valueQuantity: quantity(value, "mmHg", "mm[Hg]"),
        ...(adult ? {
            interpretation: [{ coding: [{ system: INTERPRETATION, code: flag, display: FLAGS[flag] }], text: FLAGS[flag] }],
            referenceRange: [{ low: quantity(low, "mmHg", "mm[Hg]"), high: quantity(high, "mmHg", "mm[Hg]"), text: "Adult" }],
        } : {}),
    };
};

/**
 * One measurement as an Observation. [profile] is the NRCES profile it claims: a wellness profile
 * in a WellnessRecord, the plain Observation profile in a consultation's examination.
 */
export const measurementObservation = (key: string, m: WellnessMeasurement, patient: FhirResource, profile: string, performer?: FhirResource): FhirResource => {
    const vitalCategory = sectionOf(m) === "VitalSigns" || sectionOf(m) === "BodyMeasurement"
        ? { category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }] }
        : {};
    const base = {
        resourceType: "Observation",
        id: resourceId("Observation", key),
        meta: { profile: [NRCES + profile] },
        status: "final",
        ...vitalCategory,
        subject: ref(patient, "Patient"),
        effectiveDateTime: fhirDateTime(m.at),
        ...(performer ? { performer: [ref(performer, performer.resourceType)] } : {}),
    };

    if (m.kind === "bloodPressure") {
        const age = ageAt(patient.birthDate, m.at);
        const adult = age !== null && age >= 18;
        return {
            ...base,
            text: narrative(`Blood pressure ${m.systolic}/${m.diastolic} mmHg`),
            code: { coding: [{ system: LOINC, code: BLOOD_PRESSURE.code, display: BLOOD_PRESSURE.display }], text: "Blood pressure" },
            component: [
                bpComponent("8480-6", "Systolic blood pressure", m.systolic, 90, 139, adult),
                bpComponent("8462-4", "Diastolic blood pressure", m.diastolic, 60, 89, adult),
            ],
        };
    }

    const measure = MEASURES[m.kind];
    // A temperature above 45 is Fahrenheit: the desk records 98.6, not 37.
    const [unit, ucum] = m.kind === "temperature" && m.value > 45 ? ["°F", "[degF]"] : [measure.unit, measure.ucum];
    return {
        ...base,
        text: narrative(`${measure.display}: ${m.value} ${unit}`),
        code: { coding: [{ system: LOINC, code: measure.code, display: measure.display }], text: measure.display },
        valueQuantity: quantity(m.value, unit, ucum),
    };
};

const firstNumber = (text?: string | null): number | null => {
    const match = text?.match(/\d+(\.\d+)?/);
    const value = match ? Number(match[0]) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
};

/** Vitals typed at a visit ("120/80", "72", "98.4") as measurements; anything unreadable is left out, not guessed. */
export const visitVitalsToMeasurements = (v: VisitVitals | null | undefined, at: Date): WellnessMeasurement[] => {
    if (!v) return [];
    const out: WellnessMeasurement[] = [];
    const bp = v.bloodPressure?.match(/^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/);
    if (bp) out.push({ kind: "bloodPressure", systolic: Number(bp[1]), diastolic: Number(bp[2]), at });
    const add = (kind: "heartRate" | "temperature" | "weight" | "height" | "oxygenSaturation", text?: string | null) => {
        const value = firstNumber(text);
        if (value !== null) out.push({ kind, value, at });
    };
    add("heartRate", v.heartRate);
    add("temperature", v.temperature);
    add("oxygenSaturation", v.spo2);
    add("weight", v.weight);
    add("height", v.height);
    return out;
};
