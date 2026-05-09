
const nodemailer = require('nodemailer');
require('dotenv').config();

async function sendTest() {
    console.log("Starting Simple SMTP Test...");
    console.log("Host:", process.env.EMAIL_HOST);
    console.log("Port:", process.env.EMAIL_PORT);
    console.log("User:", process.env.EMAIL_USER);

    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT),
        secure: process.env.EMAIL_PORT === "465",
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
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
        console.log("Message sent: %s", info.messageId);
    } catch (error) {
        console.error("Error occurred:", error.message);
    }
}

sendTest();
