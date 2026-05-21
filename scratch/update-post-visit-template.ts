import { AppDataSource } from "../src/config/database.js";
import { Template } from "../src/models/Common/template.model.js";

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Post Visit Records | Clinicx</title>

<style>
body {
    margin:0;
    padding:0;
    background:#f4f6fb;
    font-family:'Segoe UI', Arial, sans-serif;
}
table {
    border-collapse:collapse;
    width:100%;
}
.container {
    max-width:520px;
    margin:30px auto;
    background:#ffffff;
    border-radius:12px;
    overflow:hidden;
    box-shadow:0 8px 24px rgba(0,0,0,0.08);
}
.header {
    background: linear-gradient(120deg, #1a23d8 0%, #3f5bff 40%, #6f8dff 100%);
    padding:20px;
    text-align:center;
    color:#ffffff;
}
.logo-3d {
    display:inline-block;
    padding:4px;
    border-radius:20px;
    background:rgba(255,255,255,0.15);
}
.logo-3d img {
    width:70px;
}
.header h2 {
    margin:12px 0 0;
    font-size:20px;
}
.sub-header {
    font-size:12px;
    opacity:0.9;
}
.content {
    padding:25px;
    color:#333;
    font-size:14px;
    line-height:1.6;
}
.content h1 {
    text-align:center;
    font-size:20px;
    color:#1920d9;
}
.highlight {
    background:#f1f3ff;
    border-left:4px solid #1920d9;
    padding:12px;
    border-radius:6px;
    margin:15px 0;
}
.visit-card {
    background:#fafbff;
    border:1px solid #e5e9ff;
    border-radius:8px;
    padding:14px;
    margin-top:15px;
}
.visit-card table {
    width:100%;
}
.visit-card td {
    padding:6px 0;
    font-size:13px;
}
.label {
    color:#666;
    width:40%;
}
.value {
    font-weight:600;
    color:#222;
}
.btn {
    display:inline-block;
    margin-top:22px;
    padding:12px 24px;
    background:#1920d9;
    color:#ffffff !important;
    text-decoration:none;
    border-radius:6px;
    font-weight:600;
    font-size:14px;
}
.info-note {
    background:#fef9e6;
    border-left:4px solid #f5b042;
    padding:12px;
    border-radius:6px;
    margin-top:20px;
    font-size:13px;
}
.footer {
    background:#f4f6fb;
    text-align:center;
    padding:15px;
    font-size:11px;
    color:#777;
}
.footer a {
    color:#1920d9;
    text-decoration:none;
}
</style>

</head>

<body>

<table class="container">

<tr>
<td class="header">

    <div class="logo-3d">
        <img src="https://yiraappdev.blob.core.windows.net/adminuploadedfiles/yiraai.svg" alt="Yira Logo" />
    </div>

    <h2>Yira</h2>

    <div class="sub-header">
        Powering Healthcare with Clinicx
    </div>

</td>
</tr>

<tr>
<td class="content">

    <h1>Medical Records</h1>

    <p>
        Hi <strong>{PatientName}</strong>,
    </p>

    <p>
        Your medical visit documents from 
        <strong>{HospitalName}</strong> are now available.
    </p>

    <div class="visit-card">

        <table>
            <tr>
                <td class="label">Appointment ID</td>
                <td class="value">{AppointmentNumber}</td>
            </tr>

            <tr>
                <td class="label">Doctor</td>
                <td class="value">Dr. {DoctorName}</td>
            </tr>

            <tr>
                <td class="label">Visit Date</td>
                <td class="value">{VisitDate}</td>
            </tr>

            <tr>
                <td class="label">Documents Included</td>
                <td class="value">
                    Post Visit Summary, Prescription, Medical Records
                </td>
            </tr>
        </table>

    </div>

    <div class="highlight">
        ✅ Click below to securely view and download your medical documents.
    </div>

    <div style="text-align:center;">

        <a href="{ShareLink}" class="btn">
            View Medical Records →
        </a>

    </div>

    <div class="info-note">
        This secure link may expire after 
        <strong>30 days</strong> for privacy and security reasons.
    </div>

    <p>
        Please keep these documents confidential and avoid sharing the link publicly.
    </p>

    <p>
        If you have questions regarding your records or treatment,
        please contact your hospital directly.
    </p>

    <p>
        Regards,<br/>
        <strong>Yira Health Tech Team</strong><br/>
        <a href="mailto:contact@yira.ai">
            contact@yira.ai
        </a>
    </p>

</td>
</tr>

<tr>
<td class="footer">

    © 2026 Yira Health Tech Pvt Ltd.<br/>
    Building the future of digital healthcare with Clinicx.

</td>
</tr>

</table>

</body>
</html>`;

async function run() {
    try {
        await AppDataSource.initialize();
        console.log("DB connected successfully.");

        const templateRepo = AppDataSource.getRepository(Template);
        
        let template = await templateRepo.findOne({ where: { TemplateCode: "POST_VISIT_MEDICAL_RECORDS" } });
        if (!template) {
            template = await templateRepo.findOne({ where: { Id: 7 } });
        }

        if (template) {
            console.log("Found existing template in DB. Updating...");
            template.Message = htmlContent;
            template.Title = "Your Medical Records Are Ready | Clinicx";
            template.Type = "EMAIL";
            template.Category = "POST_VISIT";
            template.Status = true;
            await templateRepo.save(template);
            console.log("Template updated successfully in DB!");
        } else {
            console.log("Template not found in DB. Creating new one...");
            const newTemplate = new Template();
            newTemplate.Id = 7;
            newTemplate.TemplateCode = "POST_VISIT_MEDICAL_RECORDS";
            newTemplate.Type = "EMAIL";
            newTemplate.Category = "POST_VISIT";
            newTemplate.Title = "Your Medical Records Are Ready | Clinicx";
            newTemplate.Message = htmlContent;
            newTemplate.Status = true;
            newTemplate.CreatedBy = "SYSTEM";
            await templateRepo.save(newTemplate);
            console.log("Template created successfully in DB!");
        }
    } catch (error) {
        console.error("Error connecting or updating DB:", error);
    } finally {
        if (AppDataSource.isInitialized) {
            await AppDataSource.destroy();
        }
    }
}

run();
