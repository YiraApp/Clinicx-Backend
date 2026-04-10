import express from 'express';
import type { Application } from 'express';
import cors from 'cors';
import { loggingMiddleware } from './middlewares/logging.middleware.js';
import router from './routes/index.js';

const app: Application = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global Logging + Auth Middleware
app.use(loggingMiddleware);

// API Routes
app.use('/api', router);

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

export default app;
