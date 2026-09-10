import { AppDataSource } from "../src/config/database.js";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
    try {
        await AppDataSource.initialize();
        console.log("[MIGRATION] Database connected successfully");

        const createTableSql = `
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'OfferBanners')
        BEGIN
            CREATE TABLE OfferBanners (
                Id INT IDENTITY(1,1) PRIMARY KEY,
                Title NVARCHAR(255) NULL,
                Description NVARCHAR(MAX) NULL,
                ImageUrl NVARCHAR(1000) NOT NULL,
                RedirectionType VARCHAR(50) NOT NULL DEFAULT 'browser',
                RedirectionUrl NVARCHAR(1000) NULL,
                InAppRoute VARCHAR(255) NULL,
                InAppParams NVARCHAR(MAX) NULL,
                IsAllOrganizations BIT NOT NULL DEFAULT 1,
                TargetOrganizationIds NVARCHAR(MAX) NULL,
                IsActive BIT NOT NULL DEFAULT 1,
                DisplayOrder INT NOT NULL DEFAULT 0,
                StartDate DATETIME NULL,
                EndDate DATETIME NULL,
                CreatedAt DATETIME NOT NULL DEFAULT GETDATE(),
                UpdatedAt DATETIME NULL
            );
            PRINT 'Created OfferBanners table';
        END
        ELSE
        BEGIN
            PRINT 'OfferBanners table already exists';
        END
        `;

        await AppDataSource.query(createTableSql);

        // Check if sample banners exist
        const countRes = await AppDataSource.query("SELECT COUNT(*) AS total FROM OfferBanners;");
        const total = countRes[0]?.total ?? 0;
        console.log(`[MIGRATION] Current OfferBanners count: ${total}`);

        if (total === 0) {
            console.log("[MIGRATION] Seeding initial offer banners...");
            const insertSeedSql = `
            INSERT INTO OfferBanners (
                Title, Description, ImageUrl, RedirectionType, RedirectionUrl, InAppRoute, IsAllOrganizations, IsActive, DisplayOrder, CreatedAt
            ) VALUES 
            (
                'Comprehensive Health Checkup',
                'Get 30% off on full body preventive health checkups this month.',
                'https://images.unsplash.com/photo-1505751172876-fa1923c5c528?auto=format&fit=crop&w=1200&q=80',
                'browser',
                'https://yirahealth.com/health-checkup',
                NULL,
                1,
                1,
                1,
                GETDATE()
            ),
            (
                'Instant Video Consultations',
                'Connect with verified specialists in under 10 minutes.',
                'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1200&q=80',
                'in_app',
                NULL,
                '/patientBookAppointment',
                1,
                1,
                2,
                GETDATE()
            ),
            (
                'Track Vital Signs & Health Trends',
                'Monitor Blood Pressure, Heart Rate, and SpO2 trends easily.',
                'https://images.unsplash.com/photo-1579684385127-1ef15d508118?auto=format&fit=crop&w=1200&q=80',
                'in_app',
                NULL,
                '/patientVitalsTracking',
                1,
                1,
                3,
                GETDATE()
            );
            `;
            await AppDataSource.query(insertSeedSql);
            console.log("[MIGRATION] Seeded 3 sample offer banners successfully.");
        }

        console.log("[MIGRATION] Migration completed successfully.");
        process.exit(0);
    } catch (err) {
        console.error("[MIGRATION] Migration error:", err);
        process.exit(1);
    }
};

run();
