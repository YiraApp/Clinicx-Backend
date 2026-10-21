import { AppDataSource } from "../../config/database.js";
import { EXTRA_MASTER_FOODS, MASTER_FOOD_TAGS } from "./diet-food-catalog.js";

export class DietMigrationService {
    static async runMigrationsAndSeed() {
        try {
            console.log("🥗 [DietMigration] Checking Diet Plan tables and indexes...");

            // 1. DietFoodItems Table
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DietFoodItems')
                BEGIN
                    CREATE TABLE DietFoodItems (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        Name NVARCHAR(200) NOT NULL,
                        Category NVARCHAR(100) NOT NULL,
                        FoodType NVARCHAR(50) NOT NULL,
                        ServingSize NVARCHAR(100) NULL,
                        CaloriesPer100g FLOAT DEFAULT 0,
                        CaloriesPerServing FLOAT DEFAULT 0,
                        ProteinG FLOAT DEFAULT 0,
                        CarbsG FLOAT DEFAULT 0,
                        FatG FLOAT DEFAULT 0,
                        FiberG FLOAT DEFAULT 0,
                        SugarG FLOAT NULL,
                        SodiumMg FLOAT NULL,
                        ImageUrl NVARCHAR(500) NULL,
                        Tags NVARCHAR(MAX) NULL,
                        IsActive BIT DEFAULT 1,
                        OrganizationId INT NULL,
                        CreatedAt DATETIME DEFAULT GETDATE()
                    );
                END;
            `);

            // Index on DietFoodItems
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_DietFoodItems_OrgId_Category' AND object_id = OBJECT_ID('DietFoodItems'))
                BEGIN
                    CREATE INDEX IX_DietFoodItems_OrgId_Category ON DietFoodItems (OrganizationId, Category, IsActive);
                END;
            `);

            // 2. DietTemplates Table
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DietTemplates')
                BEGIN
                    CREATE TABLE DietTemplates (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        Name NVARCHAR(200) NOT NULL,
                        Description NVARCHAR(1000) NULL,
                        Condition NVARCHAR(100) NULL,
                        TotalDays INT DEFAULT 7,
                        TargetCalories FLOAT NULL,
                        TargetProteinG FLOAT NULL,
                        TargetCarbsG FLOAT NULL,
                        TargetFatG FLOAT NULL,
                        DietType NVARCHAR(50) DEFAULT 'Veg',
                        GeneralNotes NVARCHAR(MAX) NULL,
                        CreatedByDoctorId UNIQUEIDENTIFIER NULL,
                        OrganizationId INT NULL,
                        HospitalId INT NULL,
                        IsOrganizationShared BIT DEFAULT 0,
                        IsSystemDefault BIT DEFAULT 0,
                        IsActive BIT DEFAULT 1,
                        CreatedAt DATETIME DEFAULT GETDATE(),
                        UpdatedAt DATETIME NULL
                    );
                END;
            `);

            // Index on DietTemplates
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_DietTemplates_OrgId' AND object_id = OBJECT_ID('DietTemplates'))
                BEGIN
                    CREATE INDEX IX_DietTemplates_OrgId ON DietTemplates (OrganizationId, IsActive, IsSystemDefault);
                END;
            `);

            // 3. DietTemplateMeals Table
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DietTemplateMeals')
                BEGIN
                    CREATE TABLE DietTemplateMeals (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        TemplateId INT NOT NULL,
                        DayNumber INT DEFAULT 1,
                        MealSlot NVARCHAR(50) NOT NULL,
                        MealTime NVARCHAR(20) NOT NULL,
                        FoodItemId INT NULL,
                        FoodName NVARCHAR(200) NOT NULL,
                        Quantity FLOAT DEFAULT 1,
                        Unit NVARCHAR(50) DEFAULT 'serving',
                        Calories FLOAT DEFAULT 0,
                        ProteinG FLOAT NULL,
                        CarbsG FLOAT NULL,
                        FatG FLOAT NULL,
                        Notes NVARCHAR(500) NULL,
                        SortOrder INT DEFAULT 0,
                        CreatedAt DATETIME DEFAULT GETDATE(),
                        CONSTRAINT FK_DietTemplateMeals_Template FOREIGN KEY (TemplateId) REFERENCES DietTemplates(Id) ON DELETE CASCADE
                    );
                END;
            `);

            // 4. PatientDietPlans Table
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientDietPlans')
                BEGIN
                    CREATE TABLE PatientDietPlans (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        PatientId UNIQUEIDENTIFIER NOT NULL,
                        AssignedByDoctorId UNIQUEIDENTIFIER NOT NULL,
                        OrganizationId INT NOT NULL,
                        HospitalId INT NULL,
                        SourceTemplateId INT NULL,
                        AppointmentId INT NULL,
                        PlanName NVARCHAR(200) NOT NULL,
                        Description NVARCHAR(1000) NULL,
                        Condition NVARCHAR(100) NULL,
                        TotalDays INT DEFAULT 7,
                        StartDate DATE NOT NULL,
                        EndDate DATE NULL,
                        TargetCalories FLOAT NULL,
                        TargetProteinG FLOAT NULL,
                        TargetCarbsG FLOAT NULL,
                        TargetFatG FLOAT NULL,
                        DietType NVARCHAR(50) DEFAULT 'Veg',
                        DoctorNotes NVARCHAR(MAX) NULL,
                        FoodsToAvoid NVARCHAR(MAX) NULL,
                        FoodsToPrefer NVARCHAR(MAX) NULL,
                        Status NVARCHAR(20) DEFAULT 'active',
                        CreatedAt DATETIME DEFAULT GETDATE(),
                        UpdatedAt DATETIME NULL
                    );
                END;
            `);

            // Indexes on PatientDietPlans
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientDietPlans_PatientId' AND object_id = OBJECT_ID('PatientDietPlans'))
                BEGIN
                    CREATE INDEX IX_PatientDietPlans_PatientId ON PatientDietPlans (PatientId, Status);
                END;
                IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PatientDietPlans_OrgId' AND object_id = OBJECT_ID('PatientDietPlans'))
                BEGIN
                    CREATE INDEX IX_PatientDietPlans_OrgId ON PatientDietPlans (OrganizationId, Status);
                END;
            `);

            // 5. PatientDietPlanMeals Table
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientDietPlanMeals')
                BEGIN
                    CREATE TABLE PatientDietPlanMeals (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        PlanId INT NOT NULL,
                        DayNumber INT DEFAULT 1,
                        MealSlot NVARCHAR(50) NOT NULL,
                        MealTime NVARCHAR(20) NOT NULL,
                        FoodItemId INT NULL,
                        FoodName NVARCHAR(200) NOT NULL,
                        Quantity FLOAT DEFAULT 1,
                        Unit NVARCHAR(50) DEFAULT 'serving',
                        Calories FLOAT DEFAULT 0,
                        ProteinG FLOAT NULL,
                        CarbsG FLOAT NULL,
                        FatG FLOAT NULL,
                        Notes NVARCHAR(500) NULL,
                        SortOrder INT DEFAULT 0,
                        CreatedAt DATETIME DEFAULT GETDATE(),
                        CONSTRAINT FK_PatientDietPlanMeals_Plan FOREIGN KEY (PlanId) REFERENCES PatientDietPlans(Id) ON DELETE CASCADE
                    );
                END;
            `);

            // Portion weight (e.g. "80 g") for each prescribed food, added after the first release
            await AppDataSource.query(`
                IF COL_LENGTH('PatientDietPlanMeals', 'WeightAmount') IS NULL
                BEGIN
                    ALTER TABLE PatientDietPlanMeals ADD WeightAmount FLOAT NULL, WeightUnit NVARCHAR(10) NULL;
                END;
            `);

            // Templates keep portion weights too, so a plan saved as a template loses nothing
            await AppDataSource.query(`
                IF COL_LENGTH('DietTemplateMeals', 'WeightAmount') IS NULL
                BEGIN
                    ALTER TABLE DietTemplateMeals ADD WeightAmount FLOAT NULL, WeightUnit NVARCHAR(10) NULL;
                END;
            `);

            // When the patient last changed their own plan, so the doctor can see it was edited
            await AppDataSource.query(`
                IF COL_LENGTH('PatientDietPlans', 'PatientModifiedAt') IS NULL
                BEGIN
                    ALTER TABLE PatientDietPlans ADD PatientModifiedAt DATETIME NULL;
                END;
            `);

            // Plans a patient creates for themselves, without a prescription
            await AppDataSource.query(`
                IF COL_LENGTH('PatientDietPlans', 'CreatedByPatient') IS NULL
                BEGIN
                    ALTER TABLE PatientDietPlans ADD CreatedByPatient BIT NOT NULL CONSTRAINT DF_PatientDietPlans_CreatedByPatient DEFAULT 0;
                END;
            `);

            // What the patient ate each day (eaten tick and an optional photo)
            await AppDataSource.query(`
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatientDietMealLogs')
                BEGIN
                    CREATE TABLE PatientDietMealLogs (
                        Id INT IDENTITY(1,1) PRIMARY KEY,
                        PlanId INT NOT NULL,
                        PlanMealId INT NOT NULL,
                        PatientId UNIQUEIDENTIFIER NOT NULL,
                        LogDate DATE NOT NULL,
                        MealSlot NVARCHAR(50) NOT NULL,
                        FoodName NVARCHAR(200) NOT NULL,
                        IsEaten BIT NOT NULL DEFAULT 0,
                        PhotoUrl NVARCHAR(1000) NULL,
                        CreatedAt DATETIME DEFAULT GETDATE(),
                        UpdatedAt DATETIME NULL,
                        CONSTRAINT FK_PatientDietMealLogs_Plan FOREIGN KEY (PlanId) REFERENCES PatientDietPlans(Id) ON DELETE CASCADE
                    );
                    CREATE UNIQUE INDEX UX_PatientDietMealLogs_Meal_Date ON PatientDietMealLogs (PlanMealId, LogDate);
                    CREATE INDEX IX_PatientDietMealLogs_Plan_Date ON PatientDietMealLogs (PlanId, LogDate);
                END;
            `);

            console.log("✅ [DietMigration] Tables & indexes verified.");

            // 6. Check and Seed Master Foods
            await this.seedMasterFoodData();
            await this.topUpMasterFoods();

            // 7. Check and Seed Starter Templates
            await this.seedStarterTemplates();

        } catch (error) {
            console.error("❌ [DietMigration] Error setting up diet tables:", error);
        }
    }

    private static async seedMasterFoodData() {
        try {
            const countResult = await AppDataSource.query(`
                SELECT COUNT(*) as count FROM DietFoodItems WHERE OrganizationId IS NULL
            `);
            const count = countResult[0]?.count || 0;

            if (count > 0) {
                console.log(`🥗 [DietMigration] Master food items already seeded (${count} items).`);
                return;
            }

            console.log("🥗 [DietMigration] Seeding master food database (English items)...");

            const foods = [
                // BREAKFAST
                { name: "Idli (2 pieces)", category: "Breakfast", foodType: "Veg", servingSize: "2 pieces (80g)", cal100: 130, calServ: 104, p: 4.0, c: 22.0, f: 0.4, fib: 1.6 },
                { name: "Plain Dosa", category: "Breakfast", foodType: "Veg", servingSize: "1 medium (90g)", cal100: 160, calServ: 145, p: 3.5, c: 28.0, f: 2.2, fib: 1.2 },
                { name: "Masala Dosa", category: "Breakfast", foodType: "Veg", servingSize: "1 dosa (150g)", cal100: 190, calServ: 285, p: 5.5, c: 42.0, f: 9.5, fib: 3.0 },
                { name: "Ragi Dosa", category: "Breakfast", foodType: "Veg", servingSize: "1 medium (85g)", cal100: 150, calServ: 128, p: 3.8, c: 25.0, f: 1.5, fib: 3.5 },
                { name: "Poha (Flattened Rice with Veggies)", category: "Breakfast", foodType: "Veg", servingSize: "1 plate (150g)", cal100: 165, calServ: 248, p: 4.5, c: 42.0, f: 6.5, fib: 2.5 },
                { name: "Upma (Semolina / Rava)", category: "Breakfast", foodType: "Veg", servingSize: "1 plate (150g)", cal100: 170, calServ: 255, p: 5.0, c: 38.0, f: 8.0, fib: 2.0 },
                { name: "Oats Porridge (with Water)", category: "Breakfast", foodType: "Vegan", servingSize: "1 bowl (200g)", cal100: 68, calServ: 136, p: 5.0, c: 24.0, f: 2.5, fib: 3.8 },
                { name: "Oats Porridge (with Low-Fat Milk)", category: "Breakfast", foodType: "Veg", servingSize: "1 bowl (250g)", cal100: 85, calServ: 212, p: 9.5, c: 32.0, f: 4.8, fib: 3.8 },
                { name: "Vegetable Dalia (Broken Wheat)", category: "Breakfast", foodType: "Veg", servingSize: "1 bowl (180g)", cal100: 110, calServ: 198, p: 6.0, c: 34.0, f: 3.5, fib: 4.5 },
                { name: "Moong Dal Chilla (Pancake)", category: "Breakfast", foodType: "Veg", servingSize: "2 pieces (120g)", cal100: 175, calServ: 210, p: 12.0, c: 26.0, f: 5.5, fib: 4.0 },
                { name: "Besan Chilla (Gram Flour Pancake)", category: "Breakfast", foodType: "Veg", servingSize: "2 pieces (120g)", cal100: 180, calServ: 216, p: 10.5, c: 28.0, f: 6.0, fib: 4.5 },
                { name: "Methi Thepla (Gujarati Flatbread)", category: "Breakfast", foodType: "Veg", servingSize: "2 pieces (70g)", cal100: 250, calServ: 175, p: 5.0, c: 25.0, f: 6.0, fib: 3.0 },
                { name: "Pesarattu (Green Gram Dosa)", category: "Breakfast", foodType: "Veg", servingSize: "1 dosa (110g)", cal100: 160, calServ: 176, p: 8.5, c: 27.0, f: 3.2, fib: 4.2 },
                { name: "Paneer Paratha (Homestyle)", category: "Breakfast", foodType: "Veg", servingSize: "1 paratha (120g)", cal100: 240, calServ: 288, p: 11.0, c: 32.0, f: 12.0, fib: 3.0 },
                { name: "Whole Wheat Bread Toast", category: "Breakfast", foodType: "Vegan", servingSize: "2 slices (60g)", cal100: 240, calServ: 144, p: 5.5, c: 27.0, f: 1.8, fib: 3.6 },
                { name: "Boiled Eggs (2 whole)", category: "Breakfast", foodType: "Egg", servingSize: "2 eggs (100g)", cal100: 155, calServ: 155, p: 13.0, c: 1.1, f: 10.6, fib: 0 },
                { name: "Egg Omelette (2 eggs, light oil)", category: "Breakfast", foodType: "Egg", servingSize: "1 serving (110g)", cal100: 175, calServ: 192, p: 13.5, c: 1.5, f: 14.0, fib: 0.2 },
                { name: "Egg Bhurji (Scrambled with Onions/Tomato)", category: "Breakfast", foodType: "Egg", servingSize: "1 plate (140g)", cal100: 165, calServ: 231, p: 14.0, c: 3.5, f: 16.5, fib: 0.8 },

                // GRAINS & STAPLES
                { name: "Chapati / Phulka (Whole Wheat)", category: "Grain", foodType: "Vegan", servingSize: "1 roti (35g)", cal100: 240, calServ: 84, p: 3.0, c: 17.5, f: 0.5, fib: 2.5 },
                { name: "Chapati with Ghee (1 tsp)", category: "Grain", foodType: "Veg", servingSize: "1 roti (40g)", cal100: 290, calServ: 116, p: 3.0, c: 17.5, f: 4.5, fib: 2.5 },
                { name: "Multigrain Roti", category: "Grain", foodType: "Vegan", servingSize: "1 roti (40g)", cal100: 230, calServ: 92, p: 4.0, c: 17.0, f: 1.0, fib: 3.5 },
                { name: "Jowar Roti (Sorghum Flatbread)", category: "Grain", foodType: "Vegan", servingSize: "1 roti (45g)", cal100: 220, calServ: 99, p: 3.5, c: 21.0, f: 0.8, fib: 3.8 },
                { name: "Bajra Roti (Pearl Millet Flatbread)", category: "Grain", foodType: "Vegan", servingSize: "1 roti (50g)", cal100: 235, calServ: 118, p: 4.2, c: 22.5, f: 1.8, fib: 4.2 },
                { name: "Ragi Roti (Finger Millet)", category: "Grain", foodType: "Vegan", servingSize: "1 roti (45g)", cal100: 215, calServ: 97, p: 3.0, c: 20.5, f: 0.7, fib: 4.5 },
                { name: "Ragi Mudde (Finger Millet Ball)", category: "Grain", foodType: "Vegan", servingSize: "1 ball (150g)", cal100: 130, calServ: 195, p: 4.5, c: 42.0, f: 1.2, fib: 7.0 },
                { name: "Steamed White Rice", category: "Grain", foodType: "Vegan", servingSize: "1 katori / cup (150g)", cal100: 130, calServ: 195, p: 4.0, c: 43.0, f: 0.4, fib: 0.6 },
                { name: "Steamed Brown Rice", category: "Grain", foodType: "Vegan", servingSize: "1 katori / cup (150g)", cal100: 111, calServ: 166, p: 3.8, c: 35.0, f: 1.4, fib: 2.8 },
                { name: "Cooked Quinoa", category: "Grain", foodType: "Vegan", servingSize: "1 cup (150g)", cal100: 120, calServ: 180, p: 6.5, c: 32.0, f: 2.8, fib: 4.0 },
                { name: "Moong Dal Khichdi", category: "Grain", foodType: "Veg", servingSize: "1 plate (200g)", cal100: 120, calServ: 240, p: 7.5, c: 40.0, f: 4.5, fib: 3.5 },
                { name: "Vegetable Pulao", category: "Grain", foodType: "Veg", servingSize: "1 plate (200g)", cal100: 140, calServ: 280, p: 5.0, c: 48.0, f: 7.0, fib: 3.0 },
                { name: "Curd Rice (Tempered)", category: "Grain", foodType: "Veg", servingSize: "1 bowl (200g)", cal100: 135, calServ: 270, p: 6.5, c: 42.0, f: 7.5, fib: 1.0 },

                // DALS & PULSES
                { name: "Moong Dal (Yellow Lentils Tadka)", category: "Protein", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 95, calServ: 142, p: 7.5, c: 18.0, f: 3.5, fib: 3.2 },
                { name: "Toor Dal (Pigeon Pea Tadka)", category: "Protein", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 105, calServ: 158, p: 8.0, c: 20.0, f: 4.0, fib: 3.5 },
                { name: "Chana Dal (Bengal Gram)", category: "Protein", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 115, calServ: 172, p: 9.0, c: 22.0, f: 4.5, fib: 4.8 },
                { name: "Masoor Dal (Red Lentils)", category: "Protein", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 100, calServ: 150, p: 8.5, c: 19.0, f: 3.5, fib: 3.8 },
                { name: "Rajma Curry (Red Kidney Beans)", category: "Protein", foodType: "Veg", servingSize: "1 katori (180g)", cal100: 125, calServ: 225, p: 10.5, c: 32.0, f: 5.0, fib: 6.5 },
                { name: "Chole Masala (Chickpeas Curry)", category: "Protein", foodType: "Veg", servingSize: "1 katori (180g)", cal100: 135, calServ: 243, p: 9.5, c: 34.0, f: 6.5, fib: 6.0 },
                { name: "Sprouted Moong Salad / Chaat", category: "Protein", foodType: "Vegan", servingSize: "1 bowl (120g)", cal100: 90, calServ: 108, p: 7.0, c: 16.0, f: 0.8, fib: 4.5 },
                { name: "Sambar (South Indian Lentil Stew)", category: "Protein", foodType: "Veg", servingSize: "1 katori (180g)", cal100: 75, calServ: 135, p: 5.0, c: 18.0, f: 3.8, fib: 3.2 },
                { name: "Panchmel Dal (5 Lentil Mix)", category: "Protein", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 110, calServ: 165, p: 9.0, c: 20.0, f: 4.5, fib: 4.2 },

                // VEGETABLES & SABZI
                { name: "Spinach Dal (Palak Dal)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 85, calServ: 128, p: 6.5, c: 15.0, f: 3.5, fib: 3.8 },
                { name: "Palak Paneer", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (160g)", cal100: 140, calServ: 224, p: 10.5, c: 8.5, f: 16.0, fib: 3.2 },
                { name: "Cauliflower & Potato Sabzi (Aloo Gobi)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (140g)", cal100: 110, calServ: 154, p: 3.0, c: 18.0, f: 6.5, fib: 3.0 },
                { name: "Ladyfinger / Okra Fry (Bhindi Masala)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (120g)", cal100: 105, calServ: 126, p: 2.5, c: 12.0, f: 6.5, fib: 3.8 },
                { name: "Eggplant Bharta (Baingan Bharta)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (130g)", cal100: 85, calServ: 110, p: 2.2, c: 10.5, f: 5.8, fib: 3.5 },
                { name: "Bottle Gourd Sabzi (Lauki Homestyle)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (140g)", cal100: 55, calServ: 77, p: 1.8, c: 8.0, f: 3.2, fib: 2.5 },
                { name: "Ridge Gourd Sabzi (Turai)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (140g)", cal100: 50, calServ: 70, p: 1.6, c: 7.5, f: 3.0, fib: 2.8 },
                { name: "Bitter Gourd Stir-Fry (Karela, low oil)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (100g)", cal100: 70, calServ: 70, p: 2.0, c: 9.0, f: 3.2, fib: 3.0 },
                { name: "Cabbage & Green Peas Sabzi", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (130g)", cal100: 75, calServ: 98, p: 3.2, c: 12.0, f: 3.5, fib: 3.5 },
                { name: "French Beans Stir Fry (Poriyal)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (120g)", cal100: 70, calServ: 84, p: 2.8, c: 10.0, f: 3.0, fib: 3.8 },
                { name: "Mixed Vegetable Curry (Carrot, Peas, Beans)", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 80, calServ: 120, p: 3.5, c: 14.0, f: 4.5, fib: 3.5 },
                { name: "Capsicum & Paneer Bhurji", category: "Vegetable", foodType: "Veg", servingSize: "1 katori (130g)", cal100: 150, calServ: 195, p: 10.0, c: 7.0, f: 14.0, fib: 2.0 },
                { name: "Cucumber, Tomato & Carrot Salad", category: "Vegetable", foodType: "Vegan", servingSize: "1 plate (150g)", cal100: 25, calServ: 38, p: 1.2, c: 7.0, f: 0.3, fib: 2.5 },
                { name: "Steamed Broccoli & Carrots", category: "Vegetable", foodType: "Vegan", servingSize: "1 cup (120g)", cal100: 35, calServ: 42, p: 2.5, c: 7.5, f: 0.4, fib: 3.2 },

                // PROTEIN & NON-VEG
                { name: "Grilled Chicken Breast (Skinless)", category: "Protein", foodType: "Non-Veg", servingSize: "1 breast (150g)", cal100: 165, calServ: 248, p: 31.0, c: 0.0, f: 4.5, fib: 0 },
                { name: "Homestyle Chicken Curry (Light Gravy)", category: "Protein", foodType: "Non-Veg", servingSize: "1 bowl (180g)", cal100: 145, calServ: 261, p: 22.0, c: 6.0, f: 14.0, fib: 1.2 },
                { name: "Chicken Tikka (Tandoori, 5 pieces)", category: "Protein", foodType: "Non-Veg", servingSize: "5 pieces (150g)", cal100: 150, calServ: 225, p: 28.0, c: 4.0, f: 8.5, fib: 0.5 },
                { name: "Egg Curry (2 Boiled Eggs with Gravy)", category: "Protein", foodType: "Egg", servingSize: "1 bowl (180g)", cal100: 130, calServ: 234, p: 14.5, c: 8.0, f: 14.5, fib: 1.5 },
                { name: "Boiled Egg Whites (3 pieces)", category: "Protein", foodType: "Egg", servingSize: "3 whites (100g)", cal100: 52, calServ: 52, p: 11.0, c: 0.7, f: 0.2, fib: 0 },
                { name: "Fish Curry (Rohu / Katla Homestyle)", category: "Protein", foodType: "Non-Veg", servingSize: "1 bowl (180g)", cal100: 120, calServ: 216, p: 20.0, c: 5.0, f: 11.0, fib: 0.8 },
                { name: "Grilled Fish Fillet (Sea Bass / Pomfret)", category: "Protein", foodType: "Non-Veg", servingSize: "1 fillet (140g)", cal100: 130, calServ: 182, p: 24.0, c: 1.0, f: 8.0, fib: 0 },
                { name: "Mutton Curry (Lean Meat, Homestyle)", category: "Protein", foodType: "Non-Veg", servingSize: "1 bowl (180g)", cal100: 185, calServ: 333, p: 24.0, c: 5.0, f: 22.0, fib: 0.8 },
                { name: "Soya Chunks Curry", category: "Protein", foodType: "Vegan", servingSize: "1 katori (160g)", cal100: 115, calServ: 184, p: 16.0, c: 14.0, f: 5.0, fib: 5.5 },
                { name: "Tofu Stir-Fry with Bell Peppers", category: "Protein", foodType: "Vegan", servingSize: "1 cup (150g)", cal100: 105, calServ: 158, p: 12.0, c: 6.0, f: 8.5, fib: 2.2 },
                { name: "Paneer (Raw Fresh Cottage Cheese)", category: "Protein", foodType: "Veg", servingSize: "50g serving", cal100: 265, calServ: 133, p: 9.2, c: 2.0, f: 10.5, fib: 0 },

                // DAIRY
                { name: "Plain Curd / Dahi (Cow Milk)", category: "Dairy", foodType: "Veg", servingSize: "1 katori (150g)", cal100: 60, calServ: 90, p: 4.8, c: 5.5, f: 4.5, fib: 0 },
                { name: "Spiced Buttermilk / Chaas", category: "Dairy", foodType: "Veg", servingSize: "1 glass (200ml)", cal100: 25, calServ: 50, p: 2.5, c: 3.2, f: 1.8, fib: 0.2 },
                { name: "Low-Fat Toned Milk (1.5% fat)", category: "Dairy", foodType: "Veg", servingSize: "1 glass (200ml)", cal100: 50, calServ: 100, p: 6.4, c: 9.8, f: 3.0, fib: 0 },
                { name: "Whole Milk (Cow Milk)", category: "Dairy", foodType: "Veg", servingSize: "1 glass (200ml)", cal100: 65, calServ: 130, p: 6.6, c: 9.5, f: 7.0, fib: 0 },
                { name: "Unsweetened Soya Milk", category: "Dairy", foodType: "Vegan", servingSize: "1 glass (200ml)", cal100: 35, calServ: 70, p: 6.0, c: 2.5, f: 3.5, fib: 1.0 },
                { name: "Unsweetened Almond Milk", category: "Dairy", foodType: "Vegan", servingSize: "1 glass (200ml)", cal100: 15, calServ: 30, p: 1.0, c: 1.0, f: 2.4, fib: 0.6 },
                { name: "Greek Yogurt (Plain, Low Fat)", category: "Dairy", foodType: "Veg", servingSize: "1 cup (150g)", cal100: 70, calServ: 105, p: 15.0, c: 5.5, f: 1.5, fib: 0 },

                // FRUITS
                { name: "Apple (Medium, with skin)", category: "Fruit", foodType: "Vegan", servingSize: "1 medium (150g)", cal100: 52, calServ: 78, p: 0.4, c: 19.5, f: 0.2, fib: 3.6 },
                { name: "Banana (Medium)", category: "Fruit", foodType: "Vegan", servingSize: "1 medium (110g)", cal100: 89, calServ: 98, p: 1.2, c: 25.0, f: 0.3, fib: 2.8 },
                { name: "Papaya (Cubed)", category: "Fruit", foodType: "Vegan", servingSize: "1 cup (150g)", cal100: 43, calServ: 65, p: 0.7, c: 15.0, f: 0.2, fib: 2.5 },
                { name: "Guava (Medium)", category: "Fruit", foodType: "Vegan", servingSize: "1 medium (100g)", cal100: 68, calServ: 68, p: 2.5, c: 14.0, f: 1.0, fib: 5.4 },
                { name: "Orange (Medium)", category: "Fruit", foodType: "Vegan", servingSize: "1 medium (130g)", cal100: 47, calServ: 61, p: 1.2, c: 15.0, f: 0.2, fib: 3.0 },
                { name: "Pomegranate Seeds", category: "Fruit", foodType: "Vegan", servingSize: "1/2 cup (85g)", cal100: 83, calServ: 71, p: 1.5, c: 16.0, f: 1.0, fib: 3.5 },
                { name: "Watermelon (Diced)", category: "Fruit", foodType: "Vegan", servingSize: "1 cup (150g)", cal100: 30, calServ: 45, p: 0.9, c: 11.0, f: 0.2, fib: 0.6 },
                { name: "Kiwi (Medium)", category: "Fruit", foodType: "Vegan", servingSize: "1 piece (75g)", cal100: 61, calServ: 46, p: 0.8, c: 11.0, f: 0.4, fib: 2.3 },

                // SNACKS & NUTS
                { name: "Roasted Makhana (Foxnuts)", category: "Snack", foodType: "Vegan", servingSize: "1 bowl (30g)", cal100: 350, calServ: 105, p: 3.0, c: 22.0, f: 0.5, fib: 2.5 },
                { name: "Roasted Chana (Bengal Gram with skin)", category: "Snack", foodType: "Vegan", servingSize: "1 fistful (35g)", cal100: 370, calServ: 130, p: 6.8, c: 20.0, f: 2.2, fib: 5.0 },
                { name: "Raw Almonds (10 pieces)", category: "Snack", foodType: "Vegan", servingSize: "10 pieces (12g)", cal100: 580, calServ: 70, p: 2.5, c: 2.5, f: 6.0, fib: 1.5 },
                { name: "Walnuts (4 halves)", category: "Snack", foodType: "Vegan", servingSize: "4 halves (12g)", cal100: 650, calServ: 78, p: 1.8, c: 1.6, f: 7.8, fib: 0.8 },
                { name: "Chia Seeds (Soaked)", category: "Snack", foodType: "Vegan", servingSize: "1 tbsp (12g dry)", cal100: 485, calServ: 58, p: 2.0, c: 5.0, f: 3.8, fib: 4.0 },
                { name: "Flax Seeds (Roasted)", category: "Snack", foodType: "Vegan", servingSize: "1 tbsp (10g)", cal100: 535, calServ: 54, p: 1.8, c: 3.0, f: 4.2, fib: 2.8 },
                { name: "Khaman Dhokla (Steamed)", category: "Snack", foodType: "Veg", servingSize: "2 pieces (70g)", cal100: 160, calServ: 112, p: 3.5, c: 18.0, f: 2.8, fib: 1.8 },
                { name: "Steamed Sweet Corn", category: "Snack", foodType: "Vegan", servingSize: "1 cup (100g)", cal100: 95, calServ: 95, p: 3.2, c: 21.0, f: 1.2, fib: 2.5 },

                // SOUPS & BEVERAGES
                { name: "Warm Lemon Water (No Sugar)", category: "Beverage", foodType: "Vegan", servingSize: "1 glass (250ml)", cal100: 4, calServ: 10, p: 0.2, c: 2.0, f: 0, fib: 0.2 },
                { name: "Green Tea (Unsweetened)", category: "Beverage", foodType: "Vegan", servingSize: "1 cup (180ml)", cal100: 1, calServ: 2, p: 0, c: 0.2, f: 0, fib: 0 },
                { name: "Black Coffee (No Sugar)", category: "Beverage", foodType: "Vegan", servingSize: "1 cup (180ml)", cal100: 2, calServ: 4, p: 0.2, c: 0.4, f: 0, fib: 0 },
                { name: "Indian Masala Chai (Low-Fat Milk, 1 tsp sugar)", category: "Beverage", foodType: "Veg", servingSize: "1 cup (150ml)", cal100: 55, calServ: 82, p: 2.8, c: 12.0, f: 2.0, fib: 0 },
                { name: "Fresh Tender Coconut Water", category: "Beverage", foodType: "Vegan", servingSize: "1 cup (200ml)", cal100: 19, calServ: 38, p: 1.4, c: 8.5, f: 0.4, fib: 1.0 },
                { name: "Golden Turmeric Milk (Haldi Doodh)", category: "Beverage", foodType: "Veg", servingSize: "1 cup (180ml)", cal100: 60, calServ: 108, p: 5.5, c: 9.0, f: 3.2, fib: 0.3 },
                { name: "Clear Vegetable Soup", category: "Beverage", foodType: "Vegan", servingSize: "1 bowl (200ml)", cal100: 25, calServ: 50, p: 1.5, c: 8.0, f: 1.0, fib: 2.0 },
                { name: "Clear Chicken Soup", category: "Beverage", foodType: "Non-Veg", servingSize: "1 bowl (200ml)", cal100: 40, calServ: 80, p: 8.0, c: 3.0, f: 2.5, fib: 0.5 },
                { name: "Tomato Soup (Homestyle, No Cream)", category: "Beverage", foodType: "Veg", servingSize: "1 bowl (200ml)", cal100: 35, calServ: 70, p: 1.8, c: 12.0, f: 1.5, fib: 2.2 },

                // HEALTHY FATS & CONDIMENTS
                { name: "Pure Desi Ghee", category: "Other", foodType: "Veg", servingSize: "1 tsp (5g)", cal100: 900, calServ: 45, p: 0, c: 0, f: 5.0, fib: 0 },
                { name: "Extra Virgin Olive Oil", category: "Other", foodType: "Vegan", servingSize: "1 tbsp (14g)", cal100: 884, calServ: 124, p: 0, c: 0, f: 14.0, fib: 0 },
                { name: "Mint & Coriander Chutney (Green Chutney)", category: "Other", foodType: "Vegan", servingSize: "1 tbsp (15g)", cal100: 45, calServ: 7, p: 0.3, c: 1.0, f: 0.2, fib: 0.5 },
                { name: "Fresh Coconut Chutney", category: "Other", foodType: "Veg", servingSize: "1 tbsp (20g)", cal100: 180, calServ: 36, p: 0.6, c: 2.0, f: 3.0, fib: 1.0 }
            ];

            for (const f of foods) {
                await AppDataSource.query(`
                    INSERT INTO DietFoodItems (
                        Name, Category, FoodType, ServingSize, CaloriesPer100g, CaloriesPerServing,
                        ProteinG, CarbsG, FatG, FiberG, IsActive, OrganizationId, CreatedAt
                    ) VALUES (
                        @0, @1, @2, @3, @4, @5, @6, @7, @8, @9, 1, NULL, GETDATE()
                    )
                `, [
                    f.name, f.category, f.foodType, f.servingSize,
                    f.cal100, f.calServ, f.p, f.c, f.f, f.fib
                ]);
            }

            console.log(`✅ [DietMigration] Successfully seeded ${foods.length} master food items.`);
        } catch (error) {
            console.error("❌ [DietMigration] Error seeding master foods:", error);
        }
    }

    /**
     * Adds catalog foods the master list doesn't have yet (matched by name),
     * and fills in local-name search tags. Safe to run on every start.
     */
    private static async topUpMasterFoods() {
        try {
            const rows: Array<{ name: string }> = await AppDataSource.query(
                `SELECT LOWER(Name) AS name FROM DietFoodItems WHERE OrganizationId IS NULL`
            );
            const existing = new Set(rows.map(r => String(r.name).trim()));
            const missing = EXTRA_MASTER_FOODS.filter(([name]) => !existing.has(name.toLowerCase()));

            for (const [name, category, foodType, servingSize, cal100, calServ, p, c, f, fib, tags] of missing) {
                await AppDataSource.query(`
                    INSERT INTO DietFoodItems (
                        Name, Category, FoodType, ServingSize, CaloriesPer100g, CaloriesPerServing,
                        ProteinG, CarbsG, FatG, FiberG, Tags, IsActive, OrganizationId, CreatedAt
                    ) VALUES (
                        @0, @1, @2, @3, @4, @5, @6, @7, @8, @9, @10, 1, NULL, GETDATE()
                    )
                `, [name, category, foodType, servingSize, cal100, calServ, p, c, f, fib, tags]);
            }

            for (const [name, tags] of Object.entries(MASTER_FOOD_TAGS)) {
                await AppDataSource.query(
                    `UPDATE DietFoodItems SET Tags = @1 WHERE OrganizationId IS NULL AND Name = @0 AND (Tags IS NULL OR Tags = '')`,
                    [name, tags]
                );
            }

            if (missing.length > 0) {
                console.log(`✅ [DietMigration] Added ${missing.length} foods to the master list.`);
            }
        } catch (error) {
            console.error("❌ [DietMigration] Error adding catalog foods:", error);
        }
    }

    private static async seedStarterTemplates() {
        try {
            const countResult = await AppDataSource.query(`
                SELECT COUNT(*) as count FROM DietTemplates WHERE IsSystemDefault = 1
            `);
            const count = countResult[0]?.count || 0;

            if (count > 0) {
                console.log(`🥗 [DietMigration] Starter diet templates already seeded (${count} templates).`);
                return;
            }

            console.log("🥗 [DietMigration] Seeding starter system diet templates...");

            // Template 1: Type 2 Diabetes Management (Vegetarian - 1500 kcal)
            const diabeticResult = await AppDataSource.query(`
                INSERT INTO DietTemplates (
                    Name, Description, Condition, TotalDays, TargetCalories, TargetProteinG,
                    TargetCarbsG, TargetFatG, DietType, GeneralNotes, CreatedByDoctorId,
                    OrganizationId, HospitalId, IsOrganizationShared, IsSystemDefault, IsActive, CreatedAt
                ) OUTPUT INSERTED.Id VALUES (
                    'Type 2 Diabetes — Vegetarian Diet (1500 kcal)',
                    'Low-glycemic index, fiber-rich Indian vegetarian meal plan designed to keep postprandial blood glucose stable.',
                    'Diabetes', 1, 1520, 65, 185, 45, 'Veg',
                    'Drink 2.5 to 3 liters of water daily. Avoid white sugar, jaggery, maida, and deep-fried items. Have meals at regular fixed timings.',
                    NULL, NULL, NULL, 1, 1, 1, GETDATE()
                )
            `);
            const diabeticTemplateId = diabeticResult[0]?.Id;

            if (diabeticTemplateId) {
                const diabeticMeals = [
                    { day: 1, slot: "Early Morning", time: "06:30 AM", name: "Warm Lemon Water (No Sugar)", qty: 1, unit: "glass", cal: 10, p: 0.2, c: 2, f: 0, notes: "Drink immediately after waking up", order: 1 },
                    { day: 1, slot: "Early Morning", time: "06:45 AM", name: "Raw Almonds (10 pieces)", qty: 1, unit: "serving", cal: 70, p: 2.5, c: 2.5, f: 6, notes: "Soaked overnight and peeled", order: 2 },
                    { day: 1, slot: "Breakfast", time: "08:30 AM", name: "Moong Dal Chilla (Pancake)", qty: 2, unit: "pieces", cal: 210, p: 12, c: 26, f: 5.5, notes: "Cook with 1/2 tsp oil only", order: 3 },
                    { day: 1, slot: "Breakfast", time: "08:30 AM", name: "Mint & Coriander Chutney (Green Chutney)", qty: 1, unit: "tbsp", cal: 7, p: 0.3, c: 1, f: 0.2, notes: "Fresh homestyle", order: 4 },
                    { day: 1, slot: "Mid-Morning", time: "11:00 AM", name: "Guava (Medium)", qty: 1, unit: "piece", cal: 68, p: 2.5, c: 14, f: 1, notes: "Low GI fruit, rich in fiber", order: 5 },
                    { day: 1, slot: "Mid-Morning", time: "11:00 AM", name: "Green Tea (Unsweetened)", qty: 1, unit: "cup", cal: 2, p: 0, c: 0.2, f: 0, notes: "No added sugar or honey", order: 6 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Multigrain Roti", qty: 2, unit: "roti", cal: 184, p: 8, c: 34, f: 2, notes: "Without ghee", order: 7 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Yellow Toor Dal", qty: 1, unit: "katori", cal: 158, p: 8, c: 20, f: 4, notes: "Light cumin-garlic tadka", order: 8 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Spinach Dal (Palak Dal)", qty: 1, unit: "katori", cal: 128, p: 6.5, c: 15, f: 3.5, notes: "Iron and fiber rich", order: 9 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Cucumber, Tomato & Carrot Salad", qty: 1, unit: "plate", cal: 38, p: 1.2, c: 7, f: 0.3, notes: "Eat salad first before roti", order: 10 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Plain Curd / Dahi (Cow Milk)", qty: 1, unit: "katori", cal: 90, p: 4.8, c: 5.5, f: 4.5, notes: "Probiotic", order: 11 },
                    { day: 1, slot: "Evening Snack", time: "05:00 PM", name: "Roasted Makhana (Foxnuts)", qty: 1, unit: "bowl", cal: 105, p: 3, c: 22, f: 0.5, notes: "Roasted in dry pan without excess oil", order: 12 },
                    { day: 1, slot: "Evening Snack", time: "05:00 PM", name: "Black Coffee (No Sugar)", qty: 1, unit: "cup", cal: 4, p: 0.2, c: 0.4, f: 0, notes: "Zero sugar", order: 13 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Moong Dal Khichdi", qty: 1, unit: "plate", cal: 240, p: 7.5, c: 40, f: 4.5, notes: "50% dal + 50% rice mix", order: 14 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Bottle Gourd Sabzi (Lauki Homestyle)", qty: 1, unit: "katori", cal: 77, p: 1.8, c: 8, f: 3.2, notes: "Easy to digest", order: 15 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Spiced Buttermilk / Chaas", qty: 1, unit: "glass", cal: 50, p: 2.5, c: 3.2, f: 1.8, notes: "With roasted cumin and mint", order: 16 },
                    { day: 1, slot: "Bedtime", time: "09:30 PM", name: "Golden Turmeric Milk (Haldi Doodh)", qty: 1, unit: "cup", cal: 80, p: 4, c: 6, f: 2.5, notes: "Skimmed milk + pinch of turmeric", order: 17 }
                ];

                for (const m of diabeticMeals) {
                    await AppDataSource.query(`
                        INSERT INTO DietTemplateMeals (
                            TemplateId, DayNumber, MealSlot, MealTime, FoodItemId,
                            FoodName, Quantity, Unit, Calories, ProteinG, CarbsG, FatG, Notes, SortOrder, CreatedAt
                        ) VALUES (
                            @0, @1, @2, @3, NULL, @4, @5, @6, @7, @8, @9, @10, @11, @12, GETDATE()
                        )
                    `, [
                        diabeticTemplateId, m.day, m.slot, m.time,
                        m.name, m.qty, m.unit, m.cal, m.p, m.c, m.f, m.notes, m.order
                    ]);
                }
            }

            // Template 2: General Healthy Balanced Diet (1800 kcal)
            const balancedResult = await AppDataSource.query(`
                INSERT INTO DietTemplates (
                    Name, Description, Condition, TotalDays, TargetCalories, TargetProteinG,
                    TargetCarbsG, TargetFatG, DietType, GeneralNotes, CreatedByDoctorId,
                    OrganizationId, HospitalId, IsOrganizationShared, IsSystemDefault, IsActive, CreatedAt
                ) OUTPUT INSERTED.Id VALUES (
                    'General Healthy Balanced Diet (1800 kcal)',
                    'Everyday nutrient-dense meal plan with balanced protein, healthy fats, and complex carbohydrates for active adults.',
                    'General Wellness', 1, 1800, 75, 230, 52, 'Veg',
                    'Maintain consistent hydration. Prioritize seasonal local vegetables and whole grains.',
                    NULL, NULL, NULL, 1, 1, 1, GETDATE()
                )
            `);
            const balancedTemplateId = balancedResult[0]?.Id;

            if (balancedTemplateId) {
                const balancedMeals = [
                    { day: 1, slot: "Early Morning", time: "06:30 AM", name: "Warm Lemon Water (No Sugar)", qty: 1, unit: "glass", cal: 10, p: 0.2, c: 2, f: 0, notes: "Hydration starter", order: 1 },
                    { day: 1, slot: "Early Morning", time: "06:45 AM", name: "Raw Almonds (10 pieces)", qty: 1, unit: "serving", cal: 70, p: 2.5, c: 2.5, f: 6, notes: "Brain and heart health", order: 2 },
                    { day: 1, slot: "Breakfast", time: "08:30 AM", name: "Idli (2 pieces)", qty: 2, unit: "pieces", cal: 104, p: 4, c: 22, f: 0.4, notes: "Steamed fermented rice cakes", order: 3 },
                    { day: 1, slot: "Breakfast", time: "08:30 AM", name: "Sambar (South Indian Lentil Stew)", qty: 1, unit: "katori", cal: 135, p: 5, c: 18, f: 3.8, notes: "Loaded with vegetables", order: 4 },
                    { day: 1, slot: "Breakfast", time: "08:30 AM", name: "Fresh Coconut Chutney", qty: 1, unit: "tbsp", cal: 36, p: 0.6, c: 2, f: 3, notes: "1 spoon portion", order: 5 },
                    { day: 1, slot: "Mid-Morning", time: "11:00 AM", name: "Apple (Medium, with skin)", qty: 1, unit: "piece", cal: 78, p: 0.4, c: 19.5, f: 0.2, notes: "Mid-morning snack", order: 6 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Chapati / Phulka (Whole Wheat)", qty: 2, unit: "roti", cal: 168, p: 6, c: 35, f: 1, notes: "Fresh whole wheat", order: 7 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Steamed Brown Rice", qty: 1, unit: "katori", cal: 166, p: 3.8, c: 35, f: 1.4, notes: "Complex carbs", order: 8 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Moong Dal (Yellow Lentils Tadka)", qty: 1, unit: "katori", cal: 142, p: 7.5, c: 18, f: 3.5, notes: "Protein source", order: 9 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Mixed Vegetable Curry (Carrot, Peas, Beans)", qty: 1, unit: "katori", cal: 120, p: 3.5, c: 14, f: 4.5, notes: "Fiber and vitamins", order: 10 },
                    { day: 1, slot: "Lunch", time: "01:30 PM", name: "Plain Curd / Dahi (Cow Milk)", qty: 1, unit: "katori", cal: 90, p: 4.8, c: 5.5, f: 4.5, notes: "Probiotic gut support", order: 11 },
                    { day: 1, slot: "Evening Snack", time: "05:00 PM", name: "Roasted Chana (Bengal Gram with skin)", qty: 1, unit: "fistful", cal: 130, p: 6.8, c: 20, f: 2.2, notes: "High protein snack", order: 12 },
                    { day: 1, slot: "Evening Snack", time: "05:00 PM", name: "Green Tea (Unsweetened)", qty: 1, unit: "cup", cal: 2, p: 0, c: 0.2, f: 0, notes: "Antioxidants", order: 13 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Chapati / Phulka (Whole Wheat)", qty: 2, unit: "roti", cal: 168, p: 6, c: 35, f: 1, notes: "Light dinner", order: 14 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Palak Paneer", qty: 1, unit: "katori", cal: 224, p: 10.5, c: 8.5, f: 16, notes: "Rich in iron and protein", order: 15 },
                    { day: 1, slot: "Dinner", time: "07:45 PM", name: "Cucumber, Tomato & Carrot Salad", qty: 1, unit: "plate", cal: 38, p: 1.2, c: 7, f: 0.3, notes: "Fresh veggies", order: 16 },
                    { day: 1, slot: "Bedtime", time: "09:30 PM", name: "Golden Turmeric Milk (Haldi Doodh)", qty: 1, unit: "cup", cal: 108, p: 5.5, c: 9, f: 3.2, notes: "Restful sleep support", order: 17 }
                ];

                for (const m of balancedMeals) {
                    await AppDataSource.query(`
                        INSERT INTO DietTemplateMeals (
                            TemplateId, DayNumber, MealSlot, MealTime, FoodItemId,
                            FoodName, Quantity, Unit, Calories, ProteinG, CarbsG, FatG, Notes, SortOrder, CreatedAt
                        ) VALUES (
                            @0, @1, @2, @3, NULL, @4, @5, @6, @7, @8, @9, @10, @11, @12, GETDATE()
                        )
                    `, [
                        balancedTemplateId, m.day, m.slot, m.time,
                        m.name, m.qty, m.unit, m.cal, m.p, m.c, m.f, m.notes, m.order
                    ]);
                }
            }

            console.log("✅ [DietMigration] Starter diet templates successfully seeded.");
        } catch (error) {
            console.error("❌ [DietMigration] Error seeding starter templates:", error);
        }
    }
}
