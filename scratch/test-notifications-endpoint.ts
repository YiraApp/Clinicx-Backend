import { AppDataSource } from "../src/config/database.js";
import { UserToken } from "../src/models/Account/usertoken.model.js";
import axios from "axios";

async function testNotifications() {
    try {
        await AppDataSource.initialize();
        const repo = AppDataSource.getRepository(UserToken);
        const active = await repo.findOne({
            where: { IsRevoked: false },
            order: { TokenId: "DESC" }
        });

        if (!active) {
            console.log("No active token found in DB");
            process.exit(1);
        }

        console.log("Testing with Token for UserId:", active.UserId);

        const res = await axios.get("http://localhost:5000/v1/api/auth/notifications", {
            headers: { Authorization: `Bearer ${active.AccessToken}` }
        });

        console.log("Status:", res.status);
        console.log("Data:", JSON.stringify(res.data, null, 2));
        process.exit(0);
    } catch (e: any) {
        console.error("Error testing notifications endpoint:", e.response?.data || e.message);
        process.exit(1);
    }
}

testNotifications();
