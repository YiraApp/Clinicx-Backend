-- ====================================================================================
-- CLINICX PRODUCTION DATABASE MIGRATION SCRIPT
-- Target Database: Clinicx_Prod (Microsoft SQL Server / Azure SQL)
-- Safe & Idempotent: All statements use IF NOT EXISTS / IF EXISTS checks
-- Generated: 2026-09-18T14:13:52.263Z
-- ====================================================================================

USE [Clinicx_Prod];
GO

-- 1.1 Hospitals.ImageUrl (for Hospital branding / logos)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[Hospitals]') 
      AND name = N'ImageUrl'
)
BEGIN
    ALTER TABLE [dbo].[Hospitals] ADD [ImageUrl] NVARCHAR(MAX) NULL;
    PRINT 'Added column Hospitals.ImageUrl';
END;
GO

-- 1.2 Organizations.ImageUrl (for Organization branding / logos)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[Organizations]') 
      AND name = N'ImageUrl'
)
BEGIN
    ALTER TABLE [dbo].[Organizations] ADD [ImageUrl] NVARCHAR(MAX) NULL;
    PRINT 'Added column Organizations.ImageUrl';
END;
GO

-- 1.3 HospitalSettingsHistory.AppointmentBookingTemplate
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[HospitalSettingsHistory]') 
      AND name = N'AppointmentBookingTemplate'
)
BEGIN
    ALTER TABLE [dbo].[HospitalSettingsHistory] ADD [AppointmentBookingTemplate] BIT NOT NULL CONSTRAINT [DF_HospitalSettingsHistory_AppointmentBookingTemplate] DEFAULT 0;
    PRINT 'Added column HospitalSettingsHistory.AppointmentBookingTemplate';
END;
GO

-- 1.4 MobileSidebarMenus.TaskCode and TaskId (for dynamic mobile menus)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[MobileSidebarMenus]') 
      AND name = N'TaskCode'
)
BEGIN
    ALTER TABLE [dbo].[MobileSidebarMenus] ADD [TaskCode] VARCHAR(100) NULL;
    PRINT 'Added column MobileSidebarMenus.TaskCode';
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[MobileSidebarMenus]') 
      AND name = N'TaskId'
)
BEGIN
    ALTER TABLE [dbo].[MobileSidebarMenus] ADD [TaskId] VARCHAR(100) NULL;
    PRINT 'Added column MobileSidebarMenus.TaskId';
END;
GO

-- 1.5 PatientMedicalRecord.SpO2 (for vital signs tracking)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[PatientMedicalRecord]') 
      AND name = N'SpO2'
)
BEGIN
    ALTER TABLE [dbo].[PatientMedicalRecord] ADD [SpO2] NVARCHAR(50) NULL;
    PRINT 'Added column PatientMedicalRecord.SpO2';
END;
GO

-- 1.6 PatientPrescription.PdfUrl (for Azure Blob / PDF storage)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[PatientPrescription]') 
      AND name = N'PdfUrl'
)
BEGIN
    ALTER TABLE [dbo].[PatientPrescription] ADD [PdfUrl] NVARCHAR(MAX) NULL;
    PRINT 'Added column PatientPrescription.PdfUrl';
END;
GO

-- 1.7 PatientPrescription.PrescriptionNumber
IF NOT EXISTS (
    SELECT 1 FROM sys.columns 
    WHERE object_id = OBJECT_ID(N'[dbo].[PatientPrescription]') 
      AND name = N'PrescriptionNumber'
)
BEGIN
    ALTER TABLE [dbo].[PatientPrescription] ADD [PrescriptionNumber] INT NULL;
    PRINT 'Added column PatientPrescription.PrescriptionNumber';
END;
GO

-- 2.1 ConsentTemplateFields
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[ConsentTemplateFields]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[ConsentTemplateFields] (
        [FieldId] INT IDENTITY(1,1) NOT NULL,
        [TemplateId] INT NOT NULL,
        [PageNumber] INT NOT NULL,
        [X] FLOAT NOT NULL,
        [Y] FLOAT NOT NULL,
        [Width] FLOAT NOT NULL CONSTRAINT [DF_ConsentTemplateFields_Width] DEFAULT 150,
        [Height] FLOAT NOT NULL CONSTRAINT [DF_ConsentTemplateFields_Height] DEFAULT 50,
        [FieldType] NVARCHAR(50) NOT NULL,
        [FieldKey] NVARCHAR(100) NULL,
        [IsRequired] BIT NOT NULL CONSTRAINT [DF_ConsentTemplateFields_IsRequired] DEFAULT 1,
        [Status] BIT NOT NULL CONSTRAINT [DF_ConsentTemplateFields_Status] DEFAULT 1,
        [IsDeleted] BIT NOT NULL CONSTRAINT [DF_ConsentTemplateFields_IsDeleted] DEFAULT 0,
        [CreatedBy] NVARCHAR(100) NULL,
        [UpdatedBy] NVARCHAR(100) NULL,
        [CreatedAt] DATETIME NOT NULL CONSTRAINT [DF_ConsentTemplateFields_CreatedAt] DEFAULT GETDATE(),
        [UpdatedAt] DATETIME NULL,
        CONSTRAINT [PK_ConsentTemplateFields] PRIMARY KEY CLUSTERED ([FieldId] ASC)
    );

    IF EXISTS (SELECT 1 FROM sys.tables WHERE name = N'ConsentTemplates')
    BEGIN
        ALTER TABLE [dbo].[ConsentTemplateFields]
        ADD CONSTRAINT [FK_ConsentTemplateFields_ConsentTemplates]
        FOREIGN KEY ([TemplateId]) REFERENCES [dbo].[ConsentTemplates] ([TemplateId]) ON DELETE CASCADE;
    END;

    PRINT 'Created table ConsentTemplateFields';
END;
GO

-- 2.2 Feedbacks
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[Feedbacks]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[Feedbacks] (
        [Id] INT IDENTITY(1,1) NOT NULL,
        [UserId] UNIQUEIDENTIFIER NULL,
        [Name] NVARCHAR(150) NOT NULL,
        [Phone] NVARCHAR(50) NULL,
        [Email] NVARCHAR(150) NULL,
        [Rating] INT NOT NULL,
        [Category] NVARCHAR(100) NULL,
        [Message] NVARCHAR(MAX) NOT NULL,
        [OrganizationId] INT NULL,
        [OrganizationName] NVARCHAR(255) NULL,
        [HospitalId] INT NULL,
        [HospitalName] NVARCHAR(255) NULL,
        [Source] VARCHAR(50) NOT NULL CONSTRAINT [DF_Feedbacks_Source] DEFAULT 'Public',
        [Status] VARCHAR(50) NOT NULL CONSTRAINT [DF_Feedbacks_Status] DEFAULT 'New',
        [AdminNotes] NVARCHAR(MAX) NULL,
        [CreatedAt] DATETIME NOT NULL CONSTRAINT [DF_Feedbacks_CreatedAt] DEFAULT GETDATE(),
        [UpdatedAt] DATETIME NULL,
        CONSTRAINT [PK_Feedbacks] PRIMARY KEY CLUSTERED ([Id] ASC)
    );
    PRINT 'Created table Feedbacks';
END;
GO

-- 2.3 OfferBanners
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[OfferBanners]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[OfferBanners] (
        [Id] INT IDENTITY(1,1) NOT NULL,
        [Title] NVARCHAR(255) NULL,
        [Description] NVARCHAR(MAX) NULL,
        [ImageUrl] NVARCHAR(1000) NOT NULL,
        [RedirectionType] VARCHAR(50) NOT NULL CONSTRAINT [DF_OfferBanners_RedirectionType] DEFAULT 'browser',
        [RedirectionUrl] NVARCHAR(1000) NULL,
        [InAppRoute] VARCHAR(255) NULL,
        [InAppParams] NVARCHAR(MAX) NULL,
        [IsAllOrganizations] BIT NOT NULL CONSTRAINT [DF_OfferBanners_IsAllOrganizations] DEFAULT 1,
        [TargetOrganizationIds] NVARCHAR(MAX) NULL,
        [IsActive] BIT NOT NULL CONSTRAINT [DF_OfferBanners_IsActive] DEFAULT 1,
        [DisplayOrder] INT NOT NULL CONSTRAINT [DF_OfferBanners_DisplayOrder] DEFAULT 0,
        [StartDate] DATETIME NULL,
        [EndDate] DATETIME NULL,
        [ShowTitle] BIT NOT NULL CONSTRAINT [DF_OfferBanners_ShowTitle] DEFAULT 1,
        [ShowDescription] BIT NOT NULL CONSTRAINT [DF_OfferBanners_ShowDescription] DEFAULT 1,
        [ShowOfferTag] BIT NOT NULL CONSTRAINT [DF_OfferBanners_ShowOfferTag] DEFAULT 1,
        [OfferTag] NVARCHAR(100) NULL CONSTRAINT [DF_OfferBanners_OfferTag] DEFAULT 'SPECIAL OFFER',
        [Placement] VARCHAR(50) NOT NULL CONSTRAINT [DF_OfferBanners_Placement] DEFAULT 'carousel',
        [MaxDisplayCount] INT NULL CONSTRAINT [DF_OfferBanners_MaxDisplayCount] DEFAULT 0,
        [CreatedAt] DATETIME NOT NULL CONSTRAINT [DF_OfferBanners_CreatedAt] DEFAULT GETDATE(),
        [UpdatedAt] DATETIME NULL,
        CONSTRAINT [PK_OfferBanners] PRIMARY KEY CLUSTERED ([Id] ASC)
    );
    PRINT 'Created table OfferBanners';
END;
GO

-- 2.4 PasswordResetTokens
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[PasswordResetTokens]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[PasswordResetTokens] (
        [Id] INT IDENTITY(1,1) NOT NULL,
        [UserId] UNIQUEIDENTIFIER NOT NULL,
        [Token] VARCHAR(500) NOT NULL,
        [ExpiryTime] DATETIME NOT NULL,
        [IsUsed] BIT NULL CONSTRAINT [DF_PasswordResetTokens_IsUsed] DEFAULT 0,
        [CreatedAt] DATETIME NULL CONSTRAINT [DF_PasswordResetTokens_CreatedAt] DEFAULT GETDATE(),
        [UsedAt] DATETIME NULL,
        CONSTRAINT [PK_PasswordResetTokens] PRIMARY KEY CLUSTERED ([Id] ASC)
    );

    IF EXISTS (SELECT 1 FROM sys.tables WHERE name = N'Users')
    BEGIN
        ALTER TABLE [dbo].[PasswordResetTokens]
        ADD CONSTRAINT [FK_PasswordResetTokens_Users]
        FOREIGN KEY ([UserId]) REFERENCES [dbo].[Users] ([Id]) ON DELETE CASCADE;
    END;

    PRINT 'Created table PasswordResetTokens';
END;
GO

-- 2.5 PatientAccessConsents
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[PatientAccessConsents]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[PatientAccessConsents] (
        [Id] INT IDENTITY(1,1) NOT NULL,
        [PatientId] UNIQUEIDENTIFIER NOT NULL,
        [DoctorId] UNIQUEIDENTIFIER NOT NULL,
        [HospitalId] INT NULL,
        [OrganizationId] INT NULL,
        [Duration] NVARCHAR(50) NOT NULL,
        [DurationMinutes] INT NOT NULL CONSTRAINT [DF_PatientAccessConsents_DurationMinutes] DEFAULT 60,
        [Status] NVARCHAR(50) NOT NULL CONSTRAINT [DF_PatientAccessConsents_Status] DEFAULT 'PENDING',
        [RequestedAt] DATETIME NOT NULL CONSTRAINT [DF_PatientAccessConsents_RequestedAt] DEFAULT GETDATE(),
        [ApprovedAt] DATETIME NULL,
        [ExpiresAt] DATETIME NULL,
        [Notes] NVARCHAR(500) NULL,
        [CreatedAt] DATETIME NULL CONSTRAINT [DF_PatientAccessConsents_CreatedAt] DEFAULT GETDATE(),
        [UpdatedAt] DATETIME NULL CONSTRAINT [DF_PatientAccessConsents_UpdatedAt] DEFAULT GETDATE(),
        CONSTRAINT [PK_PatientAccessConsents] PRIMARY KEY CLUSTERED ([Id] ASC)
    );
    PRINT 'Created table PatientAccessConsents';
END;
GO

-- 2.6 PushCampaigns
IF NOT EXISTS (
    SELECT 1 FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[PushCampaigns]') 
      AND type in (N'U')
)
BEGIN
    CREATE TABLE [dbo].[PushCampaigns] (
        [Id] INT IDENTITY(1,1) NOT NULL,
        [Title] NVARCHAR(255) NOT NULL,
        [Body] NVARCHAR(MAX) NOT NULL,
        [ImageUrl] NVARCHAR(1000) NULL,
        [HasImage] BIT NOT NULL CONSTRAINT [DF_PushCampaigns_HasImage] DEFAULT 0,
        [ScheduleType] VARCHAR(50) NOT NULL CONSTRAINT [DF_PushCampaigns_ScheduleType] DEFAULT 'now',
        [ScheduledDate] DATE NULL,
        [ScheduledTime] VARCHAR(10) NULL,
        [RecurringPattern] VARCHAR(50) NULL,
        [RecurringDays] VARCHAR(50) NULL,
        [RedirectionType] VARCHAR(50) NOT NULL CONSTRAINT [DF_PushCampaigns_RedirectionType] DEFAULT 'in_app',
        [RedirectionUrl] NVARCHAR(1000) NULL,
        [InAppRoute] VARCHAR(255) NULL CONSTRAINT [DF_PushCampaigns_InAppRoute] DEFAULT '/patientDashboard',
        [InAppParams] NVARCHAR(MAX) NULL,
        [IsAllOrganizations] BIT NOT NULL CONSTRAINT [DF_PushCampaigns_IsAllOrganizations] DEFAULT 1,
        [TargetOrganizationIds] NVARCHAR(MAX) NULL,
        [NotificationCategory] VARCHAR(50) NOT NULL CONSTRAINT [DF_PushCampaigns_NotificationCategory] DEFAULT 'GENERAL',
        [Status] VARCHAR(50) NOT NULL CONSTRAINT [DF_PushCampaigns_Status] DEFAULT 'ACTIVE',
        [IsActive] BIT NOT NULL CONSTRAINT [DF_PushCampaigns_IsActive] DEFAULT 1,
        [TotalSentCount] INT NOT NULL CONSTRAINT [DF_PushCampaigns_TotalSentCount] DEFAULT 0,
        [LastSentAt] DATETIME NULL,
        [CreatedAt] DATETIME NOT NULL CONSTRAINT [DF_PushCampaigns_CreatedAt] DEFAULT GETDATE(),
        [UpdatedAt] DATETIME NULL,
        CONSTRAINT [PK_PushCampaigns] PRIMARY KEY CLUSTERED ([Id] ASC)
    );
    PRINT 'Created table PushCampaigns';
END;
GO

-- 3.1 AppVersions (Seed active release versions)
IF NOT EXISTS (
    SELECT 1 FROM [dbo].[AppVersions] 
    WHERE [Platform] = 'ios' AND [Version] = '2.0.0'
)
BEGIN
    INSERT INTO [dbo].[AppVersions] (
        [Platform], [Version], [MinVersion], [ForceUpdate], 
        [Url], [IsLatest], [IsDeleted], [Maintenance], [Logout], [CreatedAt]
    ) VALUES (
        'ios', '2.0.0', '1.0.0', 0, 
        'https://apps.apple.com/app/yira-clinx/id6741477759', 1, 0, 0, 0, GETDATE()
    );
    PRINT 'Inserted AppVersions for iOS 2.0.0';
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM [dbo].[AppVersions] 
    WHERE [Platform] = 'android' AND [Version] = '2.0.0'
)
BEGIN
    INSERT INTO [dbo].[AppVersions] (
        [Platform], [Version], [MinVersion], [ForceUpdate], 
        [Url], [IsLatest], [IsDeleted], [Maintenance], [Logout], [CreatedAt]
    ) VALUES (
        'android', '2.0.0', '1.0.0', 0, 
        'https://play.google.com/store/apps/details?id=com.paccore.yiraclinx', 1, 0, 0, 0, GETDATE()
    );
    PRINT 'Inserted AppVersions for Android 2.0.0';
END;
GO

PRINT '✅ Production Migration Completed Successfully!';
GO
