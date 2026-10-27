/**
 * What each ABDM record builder needs, in ClinicX's terms and independent of the database:
 * AbdmHealthRecordRepository fills these from the clinic's tables, and tests fill them by hand.
 */

export interface PatientSource {
    /** Users.Id */
    id: string;
    name: string;
    gender?: string | null;
    birthDate?: string | null;
    phone?: string | null;
    abhaNumber?: string | null;
    abhaAddress?: string | null;
}

export interface PractitionerSource {
    /** Users.Id of the doctor */
    id: string;
    name: string;
    /** Medical council registration number (HealthcareProviders.RegistrationNumber). */
    registrationNumber?: string | null;
    qualification?: string | null;
}

export interface OrganizationSource {
    /** Hospitals.Id */
    id: number;
    name: string;
    /** HFR facility id, for the hospital that is the HIP. */
    hfrId?: string | null;
    phone?: string | null;
    email?: string | null;
}

/** The visit (appointment) a record was made at. */
export interface VisitRef {
    id: number;
    start: Date;
    end?: Date | null;
    teleconsultation: boolean;
}

/** Who a record is about, who wrote it, and where. */
export interface RecordParties {
    patient: PatientSource;
    practitioner: PractitionerSource;
    organization: OrganizationSource;
    /** The visit the record came from, if any: every record of one visit shares its encounter. */
    visit?: VisitRef | null;
}

/** Words as the clinician recorded them, with the SNOMED CT concept picked for them, if any. */
export interface CodedText {
    text: string;
    conceptId?: string | null;
}

export interface MedicationSource {
    id: string;
    name: string;
    /** SNOMED CT concept for the medicine, when one was picked. */
    conceptId?: string | null;
    dosage?: string | null;
    frequency?: string | null;
    duration?: string | null;
    route?: string | null;
    instructions?: string | null;
}

export interface DocumentSource {
    id: string;
    title: string;
    category?: string | null;
    contentType: string;
    data: Buffer;
    createdAt: Date;
}

/** Vitals recorded at a visit, as the clinic stores them: text, in the units the desk used. */
export interface VisitVitals {
    bloodPressure?: string | null;
    heartRate?: string | null;
    temperature?: string | null;
    weight?: string | null;
    height?: string | null;
    spo2?: string | null;
}

export interface OpConsultationSource extends RecordParties {
    /**
     * What the bundle's ids derive from: the appointment, unless the record stands alone (a
     * consultation record or a clinical note saved outside a visit), when it is that record's own.
     */
    key?: string;
    visit: VisitRef;
    chiefComplaints: CodedText[];
    examinationFindings: CodedText[];
    vitals?: VisitVitals | null;
    vitalsRecordedAt?: Date | null;
    /** PatientRegistrations.Allergies: free text. */
    allergies?: string | null;
    /** PatientRegistrations.MedicalHistory: free text. */
    medicalHistory?: string | null;
    diagnoses: CodedText[];
    procedures: CodedText[];
    medications: MedicationSource[];
    authoredOn?: Date | null;
    notes: string[];
    followUp?: Date | null;
    documents: DocumentSource[];
}

export interface PrescriptionSource extends RecordParties {
    prescription: {
        id: string;
        number?: number | null;
        date: Date;
        notes?: string | null;
        diagnoses: CodedText[];
        medications: MedicationSource[];
        /** The prescription PDF the clinic generated, attached as a Binary. */
        signedCopy?: { contentType: string; data: Buffer } | null;
    };
}

export type DiagnosticKind = "lab" | "imaging";

/** One result line of a lab or imaging report. */
export interface ReportResultSource {
    id: string;
    name: CodedText;
    value?: number | null;
    valueText?: string | null;
    unit?: string | null;
    low?: number | null;
    high?: number | null;
    referenceText?: string | null;
    interpretation?: "normal" | "high" | "low" | "abnormal" | null;
}

/**
 * A lab or imaging report: entered at the clinic (the test, its results and the conclusion), an
 * uploaded report file, or both. The file is carried whole as the report's presented form.
 */
export interface DiagnosticReportSource extends RecordParties {
    kind: DiagnosticKind;
    entered?: {
        id: string;
        test: CodedText;
        issuedAt: Date;
        collectedAt?: Date | null;
        /** The lab or imaging centre, by name. */
        performedBy?: string | null;
        specimen?: CodedText | null;
        results: ReportResultSource[];
        conclusion?: string | null;
        conclusionCodes: CodedText[];
    } | null;
    document?: DocumentSource | null;
}

export interface HealthDocumentSource extends RecordParties {
    key: string;
    date: Date;
    title: string;
    documents: DocumentSource[];
}

export type WellnessMeasurement =
    | {
        kind: "heartRate" | "respiratoryRate" | "oxygenSaturation" | "temperature" | "height" | "weight" | "bmi"
            | "steps" | "caloriesBurned" | "sleepHours" | "bloodGlucose" | "fluidIntakeLitres";
        value: number;
        at: Date;
    }
    | { kind: "bloodPressure"; systolic: number; diastolic: number; at: Date };

export interface WellnessSource extends RecordParties {
    key: string;
    date: Date;
    measurements: WellnessMeasurement[];
}

export interface InvoiceSource extends RecordParties {
    bill: {
        id: string;
        number: string;
        date: Date;
        /** AppointmentBills.BillStatus: Draft, Pending, PartiallyPaid, Paid. */
        status: string;
        subTotal: number;
        discount: number;
        total: number;
        cgst: number;
        sgst: number;
        igst: number;
        items: Array<{
            id: string;
            /** AppointmentBillItems.ItemType: Consultation, TreatmentPlan, Custom. */
            type: string;
            name: string;
            quantity: number;
            unitPrice: number;
            discount: number;
            gstAmount: number;
            total: number;
        }>;
    };
}

export interface ImmunizationSource extends RecordParties {
    key: string;
    date: Date;
    immunizations: Array<{
        id: string;
        vaccine: CodedText;
        date: Date | string;
        doseNumber?: number | null;
        lotNumber?: string | null;
        manufacturer?: string | null;
        route?: string | null;
        site?: string | null;
        nextDueDate?: Date | string | null;
        notes?: string | null;
    }>;
    certificate?: DocumentSource | null;
}

export interface DischargeSummarySource extends RecordParties {
    summary: {
        id: string;
        admittedAt: Date;
        dischargedAt: Date;
        chiefComplaints: CodedText[];
        allergies?: string | null;
        medicalHistory: CodedText[];
        examinationFindings: CodedText[];
        diagnoses: CodedText[];
        investigations?: string | null;
        procedures: CodedText[];
        medications: MedicationSource[];
        carePlan?: string | null;
        followUp?: Date | null;
        disposition?: string | null;
    };
    document?: DocumentSource | null;
}
