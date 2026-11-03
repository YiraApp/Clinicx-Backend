import express from 'express';
import type { Application } from 'express';
import cors from 'cors';
import { loggingMiddleware } from './middlewares/logging.middleware.js';
import router from './routes/index.js';
import { mobileRouterV1 } from './MobileApi/v1/routes/index.js';
import { medSenseService } from './services/Appointments/medsense.service.js';

import path from 'path';

// ClinicX Backend Application
const app: Application = express();


// Entities with a joined User row must never send its password hash to a client.
app.set('json replacer', (key: string, value: unknown) => (key === 'PasswordHash' ? undefined : value));

app.use(cors());
app.use(express.json({
    // Razorpay signs the exact bytes of its webhook, so keep them for the signature check
    verify: (req, _res, buf) => {
        if (req.url?.startsWith('/api/payments/webhook')) (req as any).rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.resolve(process.cwd(), 'public')));

// Global Logging + Auth Middleware
app.use(loggingMiddleware);

// API Routes
app.use('/api', router);

// Mobile Versioned API Routes
app.use('/v1/api', mobileRouterV1);

// MedSense report-parsing callback (authenticated by the token in its URL, not a user JWT)
app.post('/api/webhooks/medsense', async (req, res) => {
    if (!medSenseService.isValidWebhookToken(req.query.token)) {
        return res.status(401).json({ success: false });
    }
    try {
        await medSenseService.handleWebhook(req.body);
        return res.status(200).json({ success: true });
    } catch (error: any) {
        // A non-2xx reply makes MedSense send the webhook again.
        console.error('[MedSense] Webhook handling failed:', error?.message || error);
        return res.status(500).json({ success: false });
    }
});

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

export default app;
