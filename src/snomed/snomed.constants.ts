export const SNOMED_CT_INDIAN_DRUG_CODES = {
    MEDICINAL_PRODUCT: "763158003",       // Generic medicinal product
    MEDICINAL_PRODUCT_FORM: "766939001",   // Medicinal product with a specified form
    CLINICAL_DRUG: "411116001",            // Drug with specified form and strength
    PACKAGED_CLINICAL_DRUG: "410942007",   // Packaged drug
    REAL_CLINICAL_DRUG: "324072007",       // Real-world clinical drug
    REAL_MEDICINAL_PRODUCT: "763087004",   // Real-world medicinal product
    REAL_PACKAGED_CLINICAL_DRUG: "441856006", // Real-world packaged drug
    BRAND_PRODUCT: "787859002",            // Brand-name drug
    PRODUCT_NAME: "900000000000013009"     // Product name in SNOMED CT
};

export const SNOMED_CT_PARENT_IDS = {
    SITUATION_WITH_PROCEDURE: "243796009 OR <<71388002",
    PROCEDURE: "71388002",
    DoseInstruction : "386359008",
    DISORDER: "64572001",
    FINDING: "404684003",
    Drug_Type: "373873005",
    OBSERVABLE_ENTITY: "363787002",
    BODY_STRUCTURE: "123037004",
    ORGANISM: "410607006",
    SUBSTANCE: "105590001",
    SPECIMEN: "123038009",
    SPECIAL_CONCEPT: "370115009",
    LINKAGE_CONCEPT: "106237007",
    PHYSICAL_FORCE: "78621006",
    EVENT: "272379006",
    ENVIRONMENT: "276339004",
    GEOGRAPHIC_LOCATION: "223496003",
    SOCIAL_CONCEPT: "48176007",
    SITUATION_WITH_EXPLICIT_CONTEXT: "243796009",
    STAGING_SCALE: "254291000",
    PHYSICAL_OBJECT: "260787004",
    QUALIFIER_VALUE: "362981000",
    AdditionalDosageInstructions: "419492006",
    RECORD_ARTIFACT: "419891008",
    PERSON: "125676002",
    LINK_ASSERTION: "416237000",
    NAMESPACE_CONCEPT: "370134009",
    ATTRIBUTE: "246061005",
    ASSESSMENT_SCALE: "273249006",
    RACIAL_GROUP: "415229000",
    TUMOR_STAGING: "122869004",
    OCCUPATION: "14679004",
    MORPHOLOGIC_ABNORMALITY: "49755003",
    CELL: "734163000",
    CELL_STRUCTURE: "264955002",
    ETHNIC_GROUP: "372148003",
    PRODUCT: "373873005",
    INACTIVE_CONCEPT: "255402007",
    NAVIGATIONAL_CONCEPT: "363743006",
    LIFE_STYLE: "160244002",
    REGIME_THERAPY: "277132007",
    RELIGION_PHILOSOPHY: "370112000",
    DISPOSITION: "726711005",
    MEDICINAL_PRODUCT: "763158003",
    MEDICINAL_PRODUCT_FORM: "766939001",
    CLINICAL_DRUG: "411116001",
    UNIT_OF_PRESENTATION: "732935002",
    NUMBER: "260299005",
    ADMINISTRATION_METHOD: "284009009",
    BASIC_DOSE_FORM: "736476002",
    DOSE_FORM: "736542009",
    INTENDED_SITE: "738774007",
    RELEASE_CHARACTERISTIC: "736468003",
    STATE_OF_MATTER: "7389001",
    TRANSFORMATION: "264361005",
    ROLE: "766940000",
    BRAND_PRODUCT: "787859002",
    PRODUCT_NAME: "900000000000013009",
    PACKAGED_CLINICAL_DRUG: "410942007",
    REAL_CLINICAL_DRUG: "324072007",
    REAL_MEDICINAL_PRODUCT: "763087004",
    REAL_PACKAGED_CLINICAL_DRUG: "441856006",
    SUPPLIER: "78621006"
};

export const ucumCodes = [
    { unit: "beats per minute", code: "/min", display: "Heart Rate (beats per minute)" },
    { unit: "millimeter of mercury", code: "mm[Hg]", display: "Blood Pressure (mmHg)" },
    { unit: "degree Celsius", code: "Cel", display: "Temperature (°C)" },
    { unit: "kilogram", code: "kg", display: "Weight (kg)" },
    { unit: "centimeter", code: "cm", display: "Height (cm)" },
    { unit: "kg/m²", code: "kg/m2", display: "Body Mass Index (BMI)" },
    { unit: "percentage", code: "%", display: "Oxygen Saturation / Body Fat (%)" },
    { unit: "breaths per minute", code: "/min", display: "Respiratory Rate (breaths per minute)" },
    { unit: "milligram/deciliter", code: "mg/dL", display: "Glucose Level / Cholesterol (mg/dL)" },
    { unit: "count", code: "{count}", display: "Step Count" },
    { unit: "meter", code: "m", display: "Distance Walked (m)" },
    { unit: "kilocalorie", code: "kcal", display: "Calories Burned (kcal)" }
];

export const SNOMED_BASE_URL = "http://52.165.81.116:8080";
export const BRANCH_INTERNATIONAL = "MAIN";
export const BRANCH_INDIAN = "MAIN/SNOMEDCT-IN";
