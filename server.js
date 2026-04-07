import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import aiRoutes from './routes/ai.js';
import dataRoutes from './routes/data.js';
import authRoutes from './routes/auth.js';
import stripeWebhook from './routes/stripe.js'; // stripe webhook needs raw body — must register before json()

const app = express();

// ── Security ─────────────────────────────────────────────────────────────────

app.use(helmet());
app.set('trust proxy', 1); // Railway sits behind a proxy

const allowedOrigins = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Railway health checks)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // During dev also allow localhost
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────

// General: 300 requests per 15 minutes per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

// AI routes: 20 requests per minute per IP (prevents runaway API costs)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many AI requests — please wait a moment.' }
});

// ── Stripe webhook MUST be registered before express.json() ──────────────────
// Stripe requires the raw request body to verify the signature.
app.use('/api/stripe/webhook', (req, res, next) => {
  // Pass through to the route — express.raw() is applied inside the route handler
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Don't apply JSON parsing to the stripe webhook route
  if (req.path === '/api/stripe/webhook') return next();
  express.json({ limit: '1mb' })(req, res, next);
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/ai', aiLimiter, aiRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeWebhook);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      hasSupabase: !!process.env.SUPABASE_URL,
      hasStripe: !!process.env.STRIPE_SECRET_KEY,
      frontendUrl: process.env.FRONTEND_URL || 'not set'
    }
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Rhythm server running on port ${PORT}`);
  console.log(`Anthropic key: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? '✓' : '✗ MISSING'}`);
  console.log(`Stripe: ${process.env.STRIPE_SECRET_KEY ? '✓' : '✗ MISSING'}`);
});
