/**
 * Auth / profile routes.
 * Supabase handles signup/signin directly from the frontend.
 * These routes handle profile management (conditions, onboarding state).
 */
import express from 'express';
import { supabase, verifyUser } from '../lib/supabase.js';

const router = express.Router();

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// GET /api/auth/profile
router.get('/profile', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// PUT /api/auth/profile
router.put('/profile', requireAuth, async (req, res) => {
  const allowed = ['conditions', 'onboarding_complete', 'display_name'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// GET /api/auth/access — quick check for trial/subscription status
router.get('/access', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_status, trial_ends_at')
    .eq('id', req.user.id)
    .single();

  const trialActive = profile?.trial_ends_at && new Date(profile.trial_ends_at) > new Date();
  const subscribed = profile?.subscription_status === 'active';
  const promoAccess = profile?.subscription_status === 'promo';
  const trialDaysLeft = trialActive
    ? Math.ceil((new Date(profile.trial_ends_at) - new Date()) / 864e5)
    : 0;

  res.json({
    hasAccess: trialActive || subscribed || promoAccess,
    isSubscribed: subscribed,
    isTrial: trialActive,
    isPromo: promoAccess,
    trialDaysLeft,
    subscriptionStatus: profile?.subscription_status || 'none'
  });
});

export default router;
