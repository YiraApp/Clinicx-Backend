/**
 * A prescription as the web form sends it, mapped to the entity (header, medicines, diagnoses).
 * Shared by POST/PUT /api/prescriptions and the ABDM PDF preview, so a preview shows exactly what
 * saving would store.
 */

export const normalizeMedication = (med: any) => {
    let durVal: number | undefined = undefined;
    if (typeof med.durationValue === "number" && !isNaN(med.durationValue)) {
        durVal = med.durationValue;
    } else if (med.durationValue) {
        const parsed = parseInt(String(med.durationValue).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    } else if (med.duration) {
        const parsed = parseInt(String(med.duration).replace(/[^0-9]/g, ""));
        if (!isNaN(parsed)) durVal = parsed;
    }

    return {
        Medication: med.medication || med.Medication || med.name || med.Name,
        ConceptId: med.conceptId || med.ConceptId,
        Dosage: med.dosage || med.Dosage,
        DurationValue: durVal,
        DurationUnit: med.durationUnit || med.DurationUnit || (med.duration && isNaN(Number(med.duration)) ? med.duration : "Days"),
        FrequencyType: med.frequencyType || med.FrequencyType || med.frequency || med.Frequency,
        Instructions: med.instructions || med.Instructions || med.note || med.Note,
        Route: med.route || med.Route,
        CreatedBy: med.createdBy || med.CreatedBy,
        UpdatedBy: med.updatedBy || med.UpdatedBy,
        Schedules: med.schedules,
        Days: med.days
    };
};

export const normalizeDiagnosis = (diag: any) => {
    if (!diag) return null;
    return {
        Diagnosis: typeof diag === "string" ? diag : diag.diagnosis || diag.Diagnosis,
        DiagnosisConceptId: diag.diagnosisConceptId || diag.DiagnosisConceptId
    };
};

export const buildPrescriptionHeader = (source: any) => {
    const diagnoses = Array.isArray(source.diagnoses)
        ? source.diagnoses.map(normalizeDiagnosis).filter(Boolean)
        : source.diagnosis
            ? [normalizeDiagnosis(source)]
            : [];

    const medications = Array.isArray(source.medications)
        ? source.medications.map(normalizeMedication).filter((med: any) => !!med.Medication)
        : [normalizeMedication(source)].filter((med: any) => !!med.Medication);

    return {
        PatientId: source.patientId || source.PatientId,
        DoctorId: source.doctorId || source.DoctorId || null,
        AppointmentId: source.appointmentId ?? source.AppointmentId ?? null,
        MedicalRecordId: source.medicalRecordId || source.MedicalRecordId,
        OrganizationId: source.organizationId || source.OrganizationId || source.orgId || source.OrgId,
        HospitalId: source.hospitalId || source.HospitalId || source.hospId,
        CreatedBy: source.createdBy || source.CreatedBy,
        CreatedAt: source.createdAt ? new Date(source.createdAt) : undefined,
        UpdatedAt: source.updatedAt ? new Date(source.updatedAt) : undefined,
        Diagnoses: diagnoses,
        Medications: medications,
        Notes: source.notes || source.Notes || source.prescriptionNotes || null,
        PdfUrl: source.pdfUrl || source.PdfUrl || null
    };
};
