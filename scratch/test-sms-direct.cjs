
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function testSMS() {
    console.log("Starting Native SMS Striker Test...");
    
    const username = (process.env.SMS_USER || "").trim();
    const password = (process.env.SMS_PASSWORD || "").trim();
    const baseUrl = (process.env.SMS_BASE_URL || "").trim();
    const templateId = (process.env.SMS_TEMPLATE_ID || "").trim();
    const to = "919908875796"; 
    const msg = "Hello mani neeli, please sign the consent form for your visit at applol: http://localhost:4200/sign-consent/6B8F4A63-DEB1-4214-8892-6CC617308266 - ClinicX";

    const url = `${baseUrl}?username=${username}&password=${password}&to=${to}&from=${process.env.SMS_FROM}&type=1&template_id=${templateId}&msg=${encodeURIComponent(msg)}`;

    console.log("Requesting URL (masked):", url.replace(password, "****"));

    https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            console.log("Response from SMS Striker:", data);
        });
    }).on("error", (err) => {
        console.log("Error: " + err.message);
    });
}

testSMS();
