import { AppDataSource } from "../src/config/database.js";
import { Template } from "../src/models/Common/template.model.js";

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Consent Form Required | Clinicx</title>

<style>
body {
    margin:0;
    padding:0;
    background:#f4f6fb;
    font-family: 'Segoe UI', Arial, sans-serif;
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
    background: linear-gradient(120deg, #1a23d8 0%, #3f5bff 40%, #6f8dff 100%, #3f5bff 70%, #1a23d8 100%);
    padding:20px;
    text-align:center;
    color:#ffffff;
}
.logo-3d {
    display:inline-block;
    padding:4px;
    border-radius:20px;
    background: linear-gradient(145deg, rgba(255,255,255,0.35), rgba(255,255,255,0.05));
    box-shadow: 0 6px 18px rgba(0,0,0,0.25), inset 0 1px 2px rgba(255,255,255,0.6), inset 0 -2px 6px rgba(0,0,0,0.15);
    border: 1px solid rgba(255,255,255,0.3);
}
.logo-3d img {
    width:70px;
    display:block;
    filter: drop-shadow(0 4px 6px rgba(0,0,0,0.3));
}
.header h2 {
    margin:12px 0 0;
    font-size:20px;
    font-weight:600;
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
    margin-bottom:10px;
}
.highlight {
    background:#f1f3ff;
    border-left:4px solid #1920d9;
    padding:12px;
    border-radius:6px;
    margin:15px 0;
}
.btn {
    display:inline-block;
    margin-top:20px;
    padding:12px 24px;
    background:#1920d9;
    color:#fff !important;
    text-decoration:none;
    border-radius:6px;
    font-weight:600;
    font-size:14px;
    box-shadow:0 2px 5px rgba(0,0,0,0.1);
}
.btn:hover {
    background:#0f16b0;
}
.info-note {
    background:#fef9e6;
    border-left:4px solid #f5b042;
    padding:12px;
    border-radius:6px;
    margin:15px 0;
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
    <div class="sub-header">Powering Healthcare with Clinicx</div>
</td>
</tr>

<tr>
<td class="content">

    <h1>Consent Form Required</h1>

    <p>Hi <strong>{PatientName}</strong>,</p>

    <p>
        As part of your visit to <strong>{HospitalName}</strong>, 
        we request you to review and sign the consent form.
    </p>

    <div class="highlight">
        ✅ Click the button below to securely review and sign your consent form.
    </div>

    <div style="text-align:center;">
        <a href="{ConsentLink}" class="btn">Review & Sign Consent →</a>
    </div>

    <div class="info-note">
        This link is valid for <strong>24 hours</strong>. After that, please request a new link.
    </div>

    <p>
        Your consent is required to proceed with treatment and ensure proper care.
    </p>

    <p>
        If you did not expect this request, please ignore this email or contact the hospital.
    </p>

    <p>
        Need help? Contact our support team anytime.
    </p>

    <p>
        Regards,<br/>
        <strong>Yira Health Tech Team</strong><br/>
        <a href="mailto:contact@yira.ai" style="color:#1920d9;">contact@yira.ai</a>
    </p>

</td>
</tr>

<tr>
<td class="footer">
    © 2026 Yira Health Tech Pvt Ltd. <br/>
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
        
        let template = await templateRepo.findOne({ where: { TemplateCode: "CONSENT_EMAIL" } });
        if (!template) {
            template = await templateRepo.findOne({ where: { Id: 5 } });
        }

        if (template) {
            template.Message = htmlContent;
            template.Title = "Consent Form Required | Clinicx";
            template.Type = "EMAIL";
            template.Category = "PATIENT";
            template.Status = true;
            await templateRepo.save(template);
            console.log("Template updated successfully in DB!");
        } else {
            console.log("Template not found, creating new one...");
            const newTemplate = new Template();
            newTemplate.Id = 5;
            newTemplate.TemplateCode = "CONSENT_EMAIL";
            newTemplate.Type = "EMAIL";
            newTemplate.Category = "PATIENT";
            newTemplate.Title = "Consent Form Required | Clinicx";
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
