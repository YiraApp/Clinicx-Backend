import "reflect-metadata";
import { DataSource } from "typeorm";
import dotenv from "dotenv";

import { User } from "../models/Account/user.model";
import { UserToken } from "../models/Account/usertoken.model";
import { UserOTP } from "../models/Account/userotp.model";
import { Address } from "../models/Account/address.model";
import { Role } from "../models/Account/role.model";
import { UserRole } from "../models/Account/userrole.model";
import { Organization } from "../models/Organizations/organization.model";
import { Hospital } from "../models/Organizations/hospital.model";
import { APILog } from "../models/Logs/apilog.model";
import { SidebarMenu } from "../models/Common/sidebar-menu.model";
import { RoleSidebarMenu } from "../models/Common/role-sidebar-menu.model";
import { Template } from "../models/Common/template.model";
import { MainSpecialty } from "../models/Masters/main-specialty.model";
import { MainSubSpecialty } from "../models/Masters/main-subspecialty.model";
import { MainDepartment } from "../models/Masters/main-department.model";
import { HospitalSpecialty } from "../models/Organizations/hospital-specialty.model";
import { HospitalSubSpecialty } from "../models/Organizations/hospital-subspecialty.model";
import { HospitalDepartment } from "../models/Organizations/hospital-department.model";
import { HealthcareProvider } from "../models/Organizations/healthcare-provider.model";
import { HealthcareProviderAvailability } from "../models/Organizations/healthcare-provider-availability.model";
import { PatientRegistration } from "../models/Organizations/patient-registration.model";
import { PatientInsurance } from "../models/Organizations/patient-insurance.model";
import { UserRegistrationLink } from "../models/Organizations/user-registration-link.model";

dotenv.config();

if (!process.env.DB_HOST || !process.env.DB_PORT || !process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
    throw new Error("Database configuration missing in .env file");
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
        PatientRegistration, PatientInsurance, UserRegistrationLink
    ],
    extra: {
        encrypt: true,
        trustServerCertificate: true,
    },
});

export const initializeDatabase = async () => {
    try {
        await AppDataSource.initialize();
        console.log("✅ Database connected");
    } catch (err) {
        console.error("❌ DB Error:", err);
        throw err;
    }
};