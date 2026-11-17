export interface StandardLabTest {
    name: string;
    code: string;
    category: string;
    sampleType: string;
    preparation?: string;
}

const FASTING = "Fast for 8 to 10 hours before the test";

/** Common tests each hospital starts with. Hospital admins then edit their own list. */
export const STANDARD_LAB_TESTS: StandardLabTest[] = [
    { name: "Complete Blood Count (CBC)", code: "CBC", category: "Hematology", sampleType: "Blood" },
    { name: "Hemoglobin", code: "HB", category: "Hematology", sampleType: "Blood" },
    { name: "Erythrocyte Sedimentation Rate (ESR)", code: "ESR", category: "Hematology", sampleType: "Blood" },
    { name: "Peripheral Blood Smear", code: "PBS", category: "Hematology", sampleType: "Blood" },
    { name: "Blood Group and Rh Typing", code: "BGRH", category: "Hematology", sampleType: "Blood" },
    { name: "Prothrombin Time (PT/INR)", code: "PTINR", category: "Hematology", sampleType: "Blood" },

    { name: "Fasting Blood Sugar (FBS)", code: "FBS", category: "Diabetes", sampleType: "Blood", preparation: FASTING },
    { name: "Post Prandial Blood Sugar (PPBS)", code: "PPBS", category: "Diabetes", sampleType: "Blood", preparation: "Give the sample 2 hours after a meal" },
    { name: "Random Blood Sugar (RBS)", code: "RBS", category: "Diabetes", sampleType: "Blood" },
    { name: "HbA1c", code: "HBA1C", category: "Diabetes", sampleType: "Blood" },

    { name: "Lipid Profile", code: "LIPID", category: "Biochemistry", sampleType: "Blood", preparation: FASTING },
    { name: "Liver Function Test (LFT)", code: "LFT", category: "Biochemistry", sampleType: "Blood" },
    { name: "Kidney Function Test (KFT)", code: "KFT", category: "Biochemistry", sampleType: "Blood" },
    { name: "Serum Creatinine", code: "CREAT", category: "Biochemistry", sampleType: "Blood" },
    { name: "Blood Urea", code: "UREA", category: "Biochemistry", sampleType: "Blood" },
    { name: "Serum Uric Acid", code: "URIC", category: "Biochemistry", sampleType: "Blood" },
    { name: "Serum Electrolytes", code: "ELEC", category: "Biochemistry", sampleType: "Blood" },
    { name: "Serum Calcium", code: "CA", category: "Biochemistry", sampleType: "Blood" },

    { name: "Thyroid Profile (T3, T4, TSH)", code: "TFT", category: "Hormones", sampleType: "Blood" },
    { name: "TSH", code: "TSH", category: "Hormones", sampleType: "Blood" },
    { name: "Vitamin D (25-OH)", code: "VITD", category: "Vitamins", sampleType: "Blood" },
    { name: "Vitamin B12", code: "VITB12", category: "Vitamins", sampleType: "Blood" },
    { name: "Serum Ferritin", code: "FERR", category: "Vitamins", sampleType: "Blood" },

    { name: "C-Reactive Protein (CRP)", code: "CRP", category: "Infection", sampleType: "Blood" },
    { name: "Dengue NS1 Antigen", code: "DENGNS1", category: "Infection", sampleType: "Blood" },
    { name: "Malaria Parasite Test", code: "MP", category: "Infection", sampleType: "Blood" },
    { name: "Widal Test", code: "WIDAL", category: "Infection", sampleType: "Blood" },
    { name: "HIV I and II", code: "HIV", category: "Infection", sampleType: "Blood" },
    { name: "HBsAg", code: "HBSAG", category: "Infection", sampleType: "Blood" },

    { name: "Urine Routine and Microscopy", code: "URM", category: "Urine", sampleType: "Urine" },
    { name: "Urine Culture", code: "UCS", category: "Urine", sampleType: "Urine", preparation: "Collect a clean mid-stream sample" },
    { name: "Stool Routine", code: "STOOL", category: "Stool", sampleType: "Stool" },

    { name: "Troponin I", code: "TROPI", category: "Cardiac", sampleType: "Blood" },
    { name: "ECG", code: "ECG", category: "Cardiac", sampleType: "None" },
    { name: "2D Echo", code: "ECHO", category: "Cardiac", sampleType: "None" },

    { name: "Chest X-Ray", code: "CXR", category: "Radiology", sampleType: "None" },
    { name: "Ultrasound Abdomen", code: "USGABD", category: "Radiology", sampleType: "None", preparation: "Fast for 6 hours and keep a full bladder" },
    { name: "CT Scan", code: "CT", category: "Radiology", sampleType: "None" },
    { name: "MRI Scan", code: "MRI", category: "Radiology", sampleType: "None" },
];
