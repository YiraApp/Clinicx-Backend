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
import { PatientRegistration } from "../models/Organizations/patient-registration.model.js";
import { PatientInsurance } from "../models/Organizations/patient-insurance.model.js";
import { UserRegistrationLink } from "../models/Organizations/user-registration-link.model.js";
import { ConsentTemplate } from "../models/Consent/consent-template.model.js";
import { SignatureField } from "../models/Consent/signature-field.model.js";

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
        HealthcareProvider, HealthcareProviderAvailability,
        PatientRegistration, PatientInsurance, UserRegistrationLink,
        ConsentTemplate, SignatureField

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