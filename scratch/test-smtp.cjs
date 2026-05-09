
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function sendTest() {
    console.log("Starting Simple SMTP Test...");
    console.log("Host:", process.env.EMAIL_HOST);
    console.log("Port:", process.env.EMAIL_PORT);
    console.log("User:", process.env.EMAIL_USER);

    const transporter = nodemailer.createTransport({
        host: (process.env.EMAIL_HOST || "").trim(),
        port: parseInt((process.env.EMAIL_PORT || "587").trim()),
        secure: (process.env.EMAIL_PORT || "").trim() === "465",
        auth: {
            user: (process.env.EMAIL_USER || "").trim(),
            pass: (process.env.EMAIL_PASS || "").trim(),
        },
    });

    try {
        const info = await transporter.sendMail({
            from: `"${process.env.EMAIL_FROM_ALIAS}" <${process.env.EMAIL_FROM}>`,
            to: "neelimanikanta02@gmail.com",
            subject: "Simple SMTP Test",
            text: "If you see this, SMTP is working!",
            html: "<b>If you see this, SMTP is working!</b>"
        });
        console.log("SUCCESS! Message sent: %s", info.messageId);
    } catch (error) {
        console.error("FAILURE! Error occurred:", error.message);
    }
}

sendTest();
