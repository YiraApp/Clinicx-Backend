/**
 * A medical record (consultation or vitals check) as the web form sends it, mapped to the entity's
 * columns. Shared by POST /api/medical-records and the ABDM PDF preview, so a preview shows exactly
 * what saving would store.
 */
export const medicalRecordColumns = (body: any): any => {
    const data: any = {
        PatientId: body.patientId || body.PatientId,
        DoctorId: body.doctorId || body.DoctorId,
        AppointmentId: body.appointmentId || body.AppointmentId,
        Type: body.type || body.Type,
        ChiefComplaint: body.chiefComplaint || body.ChiefComplaint,
        ChiefComplaintConceptId: body.chiefComplaintConceptId || body.ChiefComplaintConceptId,
        Symptoms: body.symptoms || body.Symptoms,
        SymptomConceptId: body.symptomConceptId || body.SymptomConceptId,
        PhysicalExamination: body.physicalExamination || body.examination || body.PhysicalExamination,
        PhysicalExaminationConceptId: body.physicalExaminationConceptId || body.PhysicalExaminationConceptId,
        Diagnosis: body.diagnosis || body.Diagnosis,
        DiagnosisConceptId: body.diagnosisConceptId || body.DiagnosisConceptId,
        Treatment: body.treatment || body.treatmentPlan || body.Treatment,
        TreatmentConceptId: body.treatmentConceptId || body.TreatmentConceptId,
        BloodPressure: body.bloodPressure || body.BloodPressure,
        HeartRate: body.heartRate || body.HeartRate,
        Temperature: body.temperature || body.Temperature,
        Weight: body.weight || body.Weight,
        Height: body.height || body.Height,
        OrganizationId: body.organizationId || body.OrganizationId,
        HospitalId: body.hospitalId || body.HospitalId,
        Status: body.status || body.Status || "Completed",
        CreatedBy: body.createdBy || body.CreatedBy,
    };
    if (data.AppointmentId) data.AppointmentId = parseInt(String(data.AppointmentId));
    return data;
};
