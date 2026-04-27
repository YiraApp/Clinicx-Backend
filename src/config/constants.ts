/**
 * Default values for environment variables.
 * These are used as fallbacks if the variable is not defined in .env or Azure.
 */
export const DEFAULTS = {
    // Database
    DB_HOST: "yiralifesqldev.database.windows.net",
    DB_PORT: "1433",
    DB_USER: "yirauserdev",
    DB_PASSWORD: "P@ssw0rd01",
    DB_NAME: "ClinicX",

    // App
    PORT: "5000",
    NODE_ENV: "development",
    CLIENT_URL: "https://clinicx.azurewebsites.net/",
    FRONTEND_URL: "http://localhost:5173",

    // Auth
    JWT_SECRET: "XB7rm'QEmrkO5cjbc^f*ColXZ4YkoME2UGjZ#+!Z'/yjowFq+/i+rYFy`m933'*ul1#:qe",
    REFRESH_TOKEN_SECRET: "XB7rm'QEmrkO5cjbc^f*ColXZ4YkoME2UGjZ#+!Z'/yjowFq+/i+rYFy`m933'*ul1#:qe_refresh",
    JWT_ISSUER: "https://yiralife.com",
    JWT_AUDIENCE: "https://yiralife.com",
    ACCESS_TOKEN_EXPIRY: "30m",
    REFRESH_TOKEN_EXPIRY: "1d",

    // Email
    EMAIL_HOST: "smtp.sendgrid.net",
    EMAIL_PORT: "587",
    EMAIL_USER: "apikey",
    EMAIL_PASS: "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",
    EMAIL_FROM: "donotreply@yira.ai",
    EMAIL_REPLY_TO: "techsupport@yira.ai",
    EMAIL_FROM_ALIAS: "Yira Communication",
    EMAIL_REPLY_TO_ALIAS: "Yira Communication",

    // Redis
    REDIS_HOST: "localhost",
    REDIS_PORT: "6379",
    REDIS_PASSWORD: "",
    REDIS_TTL: "3600",

    // SMS Striker
    SMS_USER: "Yirahealthtech",
    SMS_PASSWORD: "a@6fd9UmU7",
    SMS_BASE_URL: "https://www.smsstriker.com/API/sms.php",
    SMS_TYPE: "1",
    SMS_TEMPLATE_ID: "1707168128214603848",
    SMS_FROM: "YIRAAI",
};
