import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[MIGRATION] Database connected successfully");

        const createTableSql = `
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PushCampaigns')
        BEGIN
            CREATE TABLE PushCampaigns (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                Title NVARCHAR(255) NOT NULL,
                Body NVARCHAR(MAX) NOT NULL,
                ImageUrl NVARCHAR(1000) NULL,
                HasImage BIT NOT NULL DEFAULT 0,
                ScheduleType VARCHAR(50) NOT NULL DEFAULT 'now', -- 'now' | 'scheduled' | 'recurring'
                ScheduledDate DATE NULL,
                ScheduledTime VARCHAR(10) NULL, -- 'HH:mm' 24-hr format (e.g. '09:00', '20:30')
                RecurringPattern VARCHAR(50) NULL, -- 'daily' | 'weekly' | 'weekdays' | 'weekends'
                RecurringDays VARCHAR(50) NULL, -- e.g. '1,3,5'
                RedirectionType VARCHAR(50) NOT NULL DEFAULT 'in_app', -- 'in_app' | 'browser'
                RedirectionUrl NVARCHAR(1000) NULL,
                InAppRoute VARCHAR(255) NULL DEFAULT '/patientDashboard',
                InAppParams NVARCHAR(MAX) NULL,
                IsAllOrganizations BIT NOT NULL DEFAULT 1,
                TargetOrganizationIds NVARCHAR(MAX) NULL,
                NotificationCategory VARCHAR(50) NOT NULL DEFAULT 'GENERAL', -- 'GENERAL' | 'HEALTH_TIP' | 'OFFER' | 'REMINDER' | 'ALERT'
                Status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SENT' | 'COMPLETED'
                IsActive BIT NOT NULL DEFAULT 1,
                TotalSentCount INT NOT NULL DEFAULT 0,
                LastSentAt DATETIME NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NULL
            );
            PRINT 'Created PushCampaigns table';
        END
        ELSE
        BEGIN
            PRINT 'PushCampaigns table already exists';
        END
        `;

        await AppDataSource.query(createTableSql);
        console.log("[MIGRATION] PushCampaigns table schema verified successfully.");

        await AppDataSource.destroy();
        process.exit(0);
    } catch (err) {
        console.error("[MIGRATION] Error creating PushCampaigns table:", err);
        process.exit(1);
    }
};

run();
