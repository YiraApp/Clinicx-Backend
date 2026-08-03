import "reflect-metadata";
import dotenv from "dotenv";
dotenv.config();

import { AppDataSource } from "../src/config/database.js";

async function run() {
    try {
        await AppDataSource.initialize();
        console.log("Database connected successfully.");
        
        // 1. Get APILogs row count
        const countRes = await AppDataSource.query(`SELECT COUNT(*) as cnt FROM APILogs`);
        console.log("APILogs Row Count:", countRes[0].cnt);
        
        // 2. Get existing indexes on APILogs
        const indexesRes = await AppDataSource.query(`
            SELECT 
                t.name AS TableName,
                ind.name AS IndexName,
                col.name AS ColumnName
            FROM 
                sys.indexes ind 
            INNER JOIN 
                sys.index_columns ic ON  ind.object_id = ic.object_id and ind.index_id = ic.index_id 
            INNER JOIN 
                sys.columns col ON ic.object_id = col.object_id and ic.column_id = col.column_id 
            INNER JOIN 
                sys.tables t ON ind.object_id = t.object_id 
            WHERE 
                t.name = 'APILogs'
            ORDER BY 
                t.name, ind.name, ic.key_ordinal;
        `);
        console.log("APILogs Indexes:", indexesRes);

        // 3. Test execution time of query
        console.log("Running the timing test...");
        const startTime = Date.now();
        const results = await AppDataSource.query(`
            SELECT TOP 20
                CASE 
                    WHEN Action = 'LOGIN' THEN 'User Logged In'
                    ELSE 
                        CASE 
                            WHEN EntityType = 'auth' THEN 'Account'
                            WHEN EntityType = 'users' THEN 'User'
                            WHEN EntityType = 'hospitals' THEN 'Hospital'
                            WHEN EntityType = 'organizations' THEN 'Organization'
                            WHEN EntityType = 'roles' THEN 'Role'
                            ELSE UPPER(LEFT(EntityType, 1)) + SUBSTRING(EntityType, 2, 100)
                        END + ' ' + 
                        CASE 
                            WHEN Action = 'CREATE' THEN 'Created'
                            WHEN Action = 'UPDATE' THEN 'Updated'
                            WHEN Action = 'DELETE' THEN 'Deleted'
                            ELSE ISNULL(Action, 'Activity')
                        END
                END AS ActivityMessage,
                UpdatedOn,
                ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, ''))), ''), 'System') as UserName,
                l.RoleName
            FROM APILogs l WITH (NOLOCK)
            LEFT JOIN Users u WITH (NOLOCK) ON l.UserId = u.Id
            WHERE Action IN ('CREATE', 'UPDATE', 'DELETE', 'LOGIN')
            AND l.OrgId = 10
            AND l.HospitalId = 12
            ORDER BY l.LogId DESC;
        `);
        console.log(`Query finished in ${Date.now() - startTime}ms. Returned ${results.length} rows.`);
        
    } catch (err) {
        console.error("Error during analysis:", err);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();
