import express from 'express';
import type { Application } from 'express';
import cors from 'cors';
import { loggingMiddleware } from './middlewares/logging.middleware.js';
import router from './routes/index.js';
import { mobileRouterV1 } from './MobileApi/v1/routes/index.js';
import { medSenseService } from './services/Appointments/medsense.service.js';
import { abdmCallbackRouter } from './routes/Abdm/abdm.routes.js';
import { hiuCallbackRouter, hiuDataPushRouter } from './routes/Abdm/hiu-callback.routes.js';

import path from 'path';

// ClinicX Backend Application
const app: Application = express();


app.use(cors());

// ABDM M3 data push from HIPs (encrypted records). It has its own JSON parser with the
// ABDM_DATA_PUSH_MAX_MB limit and a JSON 413, so it is mounted before the global 100 KB parser,
// and before the login middleware: it is authenticated by the HIP's signed token and the push token.
app.use('/api/v3/hiu/data-push', hiuDataPushRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.resolve(process.cwd(), 'public')));

// ABDM gateway callbacks (Scan and Share; M3 consent and data flow). Authenticated by ABDM's signed
// token, not a user JWT, so they sit before the login middleware, at the paths ABDM appends to the
// registered bridge URL.
app.use('/api/v3/hip', abdmCallbackRouter);
app.use('/api/v3/hiu', hiuCallbackRouter);

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
