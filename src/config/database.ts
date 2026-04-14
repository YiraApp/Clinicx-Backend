import "reflect-metadata";
import { DataSource } from "typeorm";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { User } from "../models/Account/user.model.js";
import { UserToken } from "../models/Account/usertoken.model.js";
import { Address } from "../models/Account/address.model.js";
import { Role } from "../models/Account/role.model.js";
import { UserRole } from "../models/Account/userrole.model.js";
import { Organization } from "../models/Organizations/organization.model.js";
import { Hospital } from "../models/Organizations/hospital.model.js";
import { APILog } from "../models/Logs/apilog.model.js";
import { SidebarMenu } from "../models/Common/sidebar-menu.model.js";
import { RoleSidebarMenu } from "../models/Common/role-sidebar-menu.model.js";
import { Template } from "../models/Common/template.model.js";

dotenv.config(); // Load environment variables from .env

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure all required DB config is present
if (!process.env.DB_HOST || !process.env.DB_PORT || !process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
    throw new Error("Database configuration missing in .env file");
}

export const AppDataSource = new DataSource({
    type: "mssql",
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    logging: false,
    synchronize: false,                   // Important: do NOT auto-create tables
    entities: [User, UserToken, Address, Role, UserRole, Organization, Hospital, APILog, SidebarMenu, RoleSidebarMenu, Template], // Explicitly listed for best results with ESM/TSX
    // subscribers: [join(__dirname, "../subscribers/*.{ts,js}")], // Optional
    extra: {
        encrypt: true,
        trustServerCertificate: true,
    },
});

export const initializeDatabase = async () => {
    try {
        await AppDataSource.initialize();
        console.info("Database connection initialized successfully!");
    } catch (err) {
        console.error("Error connecting to the database", err);
        throw err;
    }
};