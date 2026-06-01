import "reflect-metadata";
import { DataSource } from "typeorm/index.js";
import dotenv from "dotenv";
dotenv.config();

import { User } from "../models/Account/user.model.js";
import { UserToken } from "../models/Account/usertoken.model.js";
import { UserOTP } from "../models/Account/userotp.model.js";
import { Address } from "../models/Account/address.model.js";
import { Role } from "../models/Account/role.model.js";
import { UserRole } from "../models/Account/userrole.model.js";
import { Organization } from "../models/Organizations/organization.model.js";
import { Hospital } from "../models/Organizations/hospital.model.js";
import { APILog } from "../models/Logs/apilog.model.js";
import { SidebarMenu } from "../models/Common/sidebar-menu.model.js";
import { RoleSidebarMenu } from "../models/Common/role-sidebar-menu.model.js";
import { Template } from "../models/Common/template.model.js";
import { MainSpecialty } from "../models/Masters/main-specialty.model.js";
import { MainSubSpecialty } from "../models/Masters/main-subspecialty.model.js";
import { MainDepartment } from "../models/Masters/main-department.model.js";
import { HospitalSpecialty } from "../models/Organizations/hospital-specialty.model.js";
import { HospitalSubSpecialty } from "../models/Organizations/hospital-subspecialty.model.js";
import { HospitalDepartment } from "../models/Organizations/hospital-department.model.js";
import { HealthcareProvider } from "../models/Organizations/healthcare-provider.model.js";
import { HealthcareProviderAvailability } from "../models/Organizations/healthcare-provider-availability.model.js";
import { HealthcareProviderScheduleSlot } from "../models/Organizations/healthcare-provider-schedule-slot.model.js";
import { PatientRegistration } from "../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../models/Organizations/patient-insurance.model.js";
import { UserRegistrationLink } from "../models/Organizations/user-registration-link.model.js";
import { ConsentTemplate } from "../models/Consent/consent-template.model.js";
import { SignatureField } from "../models/Consent/signature-field.model.js";
import { Appointment } from "../models/Appointments/appointment.model.js";
import { PatientQueue } from "../models/Appointments/patient-queue.model.js";
import { PatientConsent } from "../models/Consent/patient-consent.model.js";
import { ConsentRequest } from "../models/Consent/consent-request.model.js";
import { PatientVerification } from "../models/Appointments/patient-verification.model.js";
import { PatientVerificationDocument } from "../models/Appointments/patient-verification-document.model.js";
import { ClinicalNote } from "../models/Appointments/clinical-note.model.js";
import { MedicalRecord } from "../models/Appointments/medical-record.model.js";
import { PatientMedicalRecord } from "../models/Appointments/patient-medical-record.model.js";
import { Visit } from "../models/Appointments/visit.model.js";
import { PatientDocument } from "../models/Appointments/patient-document.model.js";
import { PatientPrescription } from "../models/Appointments/patient-prescription.model.js";
import { PrescriptionDiagnosis } from "../models/Appointments/prescription-diagnosis.model.js";
import { PrescriptionMedication } from "../models/Appointments/prescription-medication.model.js";
import { PrescriptionMedicationSchedule } from "../models/Appointments/prescription-medication-schedule.model.js";
import { PrescriptionMedicationDays } from "../models/Appointments/prescription-medication-days.model.js";
import { PostVisitDocument } from "../models/Appointments/post-visit-document.model.js";
import { AppointmentShareLink } from "../models/Appointments/appointment-share-link.model.js";
import { MedicalDocument } from "../models/Appointments/medical-document.model.js";
import { Payment } from "../models/Payments/payment.model.js";
import { PaymentLog } from "../models/Payments/payment-log.model.js";
import { HospitalPaymentConfiguration } from "../models/Organizations/hospital-payment-configuration.model.js";
import { AppointmentBill } from "../models/Payments/appointment-bill.model.js";
import { AppointmentBillItem } from "../models/Payments/appointment-bill-item.model.js";
import { MeetingRedirection } from "../models/Appointments/meeting-redirection.model.js";

// Debug logs for Azure troubleshooting
if (process.env.NODE_ENV !== 'production' || true) { 
    console.log("--- Azure Environment Debug ---");
    console.log("Available Env Keys:", Object.keys(process.env).filter(k => !k.includes("PASSWORD") && !k.includes("SECRET")));
    console.log("DB_HOST exists:", !!process.env.DB_HOST);
    console.log("DB_NAME exists:", !!process.env.DB_NAME);
    console.log("-------------------------------");
}

const requiredEnvVars = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
    throw new Error(`Database configuration missing for: ${missingVars.join(", ")}. Please check your Azure Application Settings.`);
}

export const AppDataSource = new DataSource({
    type: "mssql",
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT!),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    logging: false,
    synchronize: false,
    entities: [
        User, UserToken, UserOTP, Address, Role, UserRole,
        Organization, Hospital, APILog, SidebarMenu, RoleSidebarMenu, Template,
        MainSpecialty, MainSubSpecialty, MainDepartment,
        HospitalSpecialty, HospitalSubSpecialty, HospitalDepartment,
        HealthcareProvider, HealthcareProviderAvailability, HealthcareProviderScheduleSlot,
        PatientRegistration, PatientInsurance, UserRegistrationLink,
        ConsentTemplate, SignatureField,
        Appointment, PatientQueue,
        PatientConsent, ConsentRequest,
        PatientVerification, PatientVerificationDocument,
        ClinicalNote, MedicalRecord, PatientMedicalRecord, Visit, PatientDocument, PatientPrescription,
        PrescriptionDiagnosis, PrescriptionMedication, PrescriptionMedicationSchedule, PrescriptionMedicationDays,
        PostVisitDocument, AppointmentShareLink, MedicalDocument,
        Payment, PaymentLog, HospitalPaymentConfiguration, AppointmentBill, AppointmentBillItem,
        MeetingRedirection
    ],
    extra: {
        encrypt: true,
        trustServerCertificate: true,
    },
});

export const initializeDatabase = async () => {
    try {
        console.log("ALL ENV KEYS:", Object.keys(process.env));
        console.log("DB_HOST:", process.env.DB_HOST);
        console.log("DB_USER:", process.env.DB_USER);
        console.log("DB_NAME:", process.env.DB_NAME);
        console.log(`📡 Attempting to connect to database at: ${process.env.DB_HOST}`);

        console.log(`📡 Attempting to connect to database at: ${process.env.DB_NAME}`);

        console.log(`📡 Attempting to connect to database at: ${process.env.DB_PORT}`);
        await AppDataSource.initialize();
        console.log("✅ Database connected");
    } catch (err) {
        console.error("❌ DB Error:", err);
        throw err;
    }
};