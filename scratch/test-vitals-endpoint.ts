import { AppDataSource } from "../src/config/database.js";
import { patientVitalsController } from "../src/MobileApi/v1/controllers/patient-vitals.controller.js";
import { User } from "../src/models/Account/user.model.js";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  try {
    await AppDataSource.initialize();
    console.log("DB connected");

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: {} });
    if (!user) process.exit(0);

    let sentJson: any = null;
    let statusCode = 200;
    const req: any = {
      user: { userId: user.Id, firstName: user.FirstName },
      query: {},
      params: {},
      body: {
        patientId: user.Id,
        bp: "120/80",
        pulse: "72",
        temp: "98.6",
        spO2: "98",
        weight: "68",
        height: "172"
      }
    };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(data: any) {
        sentJson = data;
        return this;
      }
    };

    await patientVitalsController.recordPatientVitals(req, res);
    console.log("POST /patient/vitals status:", statusCode);
    console.log("POST /patient/vitals response:", JSON.stringify(sentJson, null, 2));

    await AppDataSource.destroy();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

test();
