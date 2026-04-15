import express from 'express';
import Stripe from 'stripe';
import { supabase, verifyUser } from '../lib/supabase.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual:  process.env.STRIPE_PRICE_ANNUAL
};

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// POST /api/stripe/create-checkout
// Returns a Stripe Checkout URL. Frontend redirects there.
router.post('/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body;
  const priceId = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan. Use "monthly" or "annual".' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id, email')
    .eq('id', req.user.id)
    .single();

  try {
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { userId: req.user.id }
      },
      success_url: `${process.env.FRONTEND_URL}?payment=success`,
      cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
      metadata: { userId: req.user.id }
    };

    // Attach to existing Stripe customer if we have one
    if (profile?.stripe_customer_id) {
      sessionParams.customer = profile.stripe_customer_id;
    } else {
      sessionParams.customer_email = req.user.email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// GET /api/stripe/portal
// Returns a Stripe Customer Portal URL for subscription management.
router.get('/portal', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', req.user.id)
    .single();

  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: 'No subscription found.' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}?tab=profile`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Could not create portal session.' });
  }
});

// POST /api/stripe/redeem-promo
// Validates a promo code and grants full access without payment.
router.post('/redeem-promo', requireAuth, async (req, res) => {
  const code = req.body.code?.trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Code required.' });

  const { data: promo, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code)
    .eq('is_active', true)
    .single();

  if (error || !promo) return res.status(400).json({ error: 'Invalid or expired promo code.' });
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This promo code has expired.' });
  }
  if (promo.uses_count >= promo.max_uses) {
    return res.status(400).json({ error: 'This promo code has reached its limit.' });
  }

  // Grant access — time-limited if duration_days is set, permanent promo otherwise
  // Note: onboarding_complete is intentionally NOT set here so the user goes
  // through the onboarding questions and first-run guide normally.
  const profileUpdate = {};
  if (promo.duration_days) {
    profileUpdate.subscription_status = 'trial';
    profileUpdate.trial_ends_at = new Date(
      Date.now() + promo.duration_days * 24 * 60 * 60 * 1000
    ).toISOString();
  } else {
    profileUpdate.subscription_status = 'promo';
  }
  await supabase.from('profiles').update(profileUpdate).eq('id', req.user.id);

  // Increment uses
  await supabase.from('promo_codes').update({
    uses_count: promo.uses_count + 1
  }).eq('id', promo.id);

  const msg = promo.duration_days
    ? `Code applied! You have ${promo.duration_days} days of free access.`
    : 'Code applied! Welcome to Rhythm.';
  res.json({ success: true, message: msg });
});

// POST /api/stripe/webhook
// Stripe sends subscription lifecycle events here.
// Must use raw body — added before express.json() in server.js
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  // Get our userId from metadata (set at checkout creation)
  const userId =
    obj.metadata?.userId ||
    obj.subscription_data?.metadata?.userId;

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      if (!userId) break;
      const status = obj.status === 'active' || obj.status === 'trialing' ? 'active' : 'inactive';
      await supabase.from('profiles').update({
        subscription_status: status,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.id
      }).eq('id', userId);
      break;
    }

    case 'customer.subscription.deleted': {
      if (!userId) break;
      await supabase.from('profiles').update({
        subscription_status: 'cancelled'
      }).eq('id', userId);
      break;
    }

    case 'invoice.payment_failed': {
      // Look up userId by stripe_customer_id
      const customerId = obj.customer;
      await supabase.from('profiles').update({
        subscription_status: 'past_due'
      }).eq('stripe_customer_id', customerId);
      break;
    }
  }

  res.json({ received: true });
});

export default router;
