# Rhythm — Full Deployment Guide

Everything you need to go from code to live app. Follow in order.
Estimated time: ~45 minutes total.

---

## Overview

| Service | What it does | Cost |
|---|---|---|
| Supabase | User accounts + database | Free tier |
| Railway | Node.js backend server | ~$5/mo after free trial |
| Stripe | Payments | Free + 2.9% per transaction |
| Netlify | Host the PWA frontend | Free |

---

## Step 1 — Supabase (database + auth)

**1a. Create project**
1. Go to supabase.com → Sign in → New Project
2. Name it `rhythm`, pick a region close to you, set a DB password (save it)
3. Wait ~2 minutes for it to provision

**1b. Run the schema** — go to the SQL Editor and run this entire block:

```sql
-- ── Profiles ────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  display_name text,
  conditions text[],
  onboarding_complete boolean default false,
  subscription_status text default 'trial',
  trial_ends_at timestamptz default (now() + interval '7 days'),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now()
);

-- Auto-create profile row when a user signs up
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, trial_ends_at)
  values (new.id, new.email, now() + interval '7 days')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ── Episodes ─────────────────────────────────────────────────────────────────
create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  sensation_types text[],
  intensity integer,
  duration_category text,
  ai_response text,
  activity_before text,
  food_before text,
  position text,
  resolve_method text,
  resolved boolean default false,
  created_at timestamptz default now()
);

-- ── Daily check-ins ──────────────────────────────────────────────────────────
create table if not exists daily_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  date date not null,
  sleep_hours numeric,
  sleep_quality integer,
  caffeine_timing text,
  stress_level integer,
  exercise_level integer,
  digestion integer,
  hydration integer,
  alcohol_units integer default 0,
  magnesium_taken boolean default false,
  left_side_lying boolean default false,
  meal_before_episode boolean default false,
  exercise_within_2hrs boolean default false,
  created_at timestamptz default now(),
  unique(user_id, date)
);

-- ── Pattern snapshots (cached AI analysis) ───────────────────────────────────
create table if not exists pattern_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  top_triggers jsonb,
  best_day_factors text[],
  worst_day_factors text[],
  insight_text text,
  actionable_change text,
  episodes_this_week integer,
  episodes_last_week integer,
  data_quality text,
  correlations jsonb,
  generated_at timestamptz default now()
);

-- ── Promo codes ──────────────────────────────────────────────────────────────
create table if not exists promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  description text,
  max_uses integer default 100,
  uses_count integer default 0,
  expires_at timestamptz,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ── Performance indexes ───────────────────────────────────────────────────────
create index if not exists episodes_user_created on episodes(user_id, created_at desc);
create index if not exists checkins_user_date on daily_checkins(user_id, date desc);
create index if not exists snapshots_user_generated on pattern_snapshots(user_id, generated_at desc);
create index if not exists profiles_stripe_customer on profiles(stripe_customer_id);

-- ── Row Level Security ────────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table episodes enable row level security;
alter table daily_checkins enable row level security;
alter table pattern_snapshots enable row level security;
alter table promo_codes enable row level security;

create policy "own profile" on profiles for all using (auth.uid() = id);
create policy "own episodes" on episodes for all using (auth.uid() = user_id);
create policy "own checkins" on daily_checkins for all using (auth.uid() = user_id);
create policy "own snapshots" on pattern_snapshots for all using (auth.uid() = user_id);
create policy "promo read only" on promo_codes for select using (true);
```

**1c. Create your first promo code** — run this in the SQL Editor:

```sql
-- Your personal test/beta access code
INSERT INTO promo_codes (code, description, max_uses)
VALUES ('RHYTHMBETA', 'Beta tester access', 50);

-- Add more codes as needed:
-- INSERT INTO promo_codes (code, description, max_uses) VALUES ('FRIEND2024', 'Friends & family', 10);
```

**1d. Copy your keys** — go to Settings → API:
- **Project URL** → this is your `SUPABASE_URL`
- **anon public** key → needed in the PWA frontend (`js/auth.js`)
- **service_role secret** key → needed in the backend (`SUPABASE_SERVICE_KEY`)

---

## Step 2 — Anthropic API key

1. Go to console.anthropic.com → API Keys → Create Key
2. Copy it — this is your `ANTHROPIC_API_KEY`

---

## Step 3 — Stripe setup

**3a. Create products**
1. Go to dashboard.stripe.com → Products → Create product
2. Name: `Rhythm` → Add two prices:
   - **Monthly**: $17.00 / month recurring → copy price ID → `STRIPE_PRICE_MONTHLY`
   - **Annual**: $99.00 / year recurring → copy price ID → `STRIPE_PRICE_ANNUAL`

**3b. Get API key**
- Stripe → Developers → API Keys → copy **Secret key** → `STRIPE_SECRET_KEY`

*(Webhook secret comes after Railway deploy — do Step 4 first)*

---

## Step 4 — Deploy backend to Railway

**Option A — GitHub (recommended)**
1. Create a new GitHub repo called `rhythm-server`
2. Push the `rhythm-server` folder:
   ```bash
   cd "C:\Users\Logan\OneDrive\Desktop\rhythm-server"
   git init
   git add .
   git commit -m "Initial deploy"
   git remote add origin https://github.com/YOUR-USERNAME/rhythm-server.git
   git push -u origin main
   ```
3. Go to railway.app → New Project → Deploy from GitHub → select `rhythm-server`
4. Railway detects `railway.json` and deploys automatically

**Option B — Railway CLI**
```bash
npm install -g @railway/cli
cd "C:\Users\Logan\OneDrive\Desktop\rhythm-server"
npm install
railway login
railway init
railway up
```

**4a. Add environment variables** in Railway dashboard → your service → Variables:

```
ANTHROPIC_API_KEY      = sk-ant-...
SUPABASE_URL           = https://xxxx.supabase.co
SUPABASE_SERVICE_KEY   = eyJ...  (service_role key — NOT anon)
STRIPE_SECRET_KEY      = sk_live_... (or sk_test_... for testing)
STRIPE_PRICE_MONTHLY   = price_...
STRIPE_PRICE_ANNUAL    = price_...
STRIPE_WEBHOOK_SECRET  = whsec_...  (add after next step)
FRONTEND_URL           = https://your-netlify-url.netlify.app
PORT                   = 3001
```

**4b. Verify it's live:**
```bash
curl https://YOUR-RAILWAY-URL.up.railway.app/health
# Should return: {"status":"ok","env":{"hasAnthropicKey":true,"hasSupabase":true,...}}
```

Your Railway URL will look like: `https://rhythm-server-production.up.railway.app`

---

## Step 5 — Set up Stripe webhook

Now that you have a Railway URL:

1. Stripe → Developers → Webhooks → Add endpoint
2. URL: `https://YOUR-RAILWAY-URL.up.railway.app/api/stripe/webhook`
3. Select events:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Click Add endpoint → copy **Signing secret** → `STRIPE_WEBHOOK_SECRET`
5. Add it to Railway environment variables → Railway auto-redeploys

---

## Step 6 — Update the PWA frontend

Open `js/auth.js` and set your Supabase credentials:
```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...your-anon-public-key...';
```

Open `js/api.js` and set your Railway URL:
```js
const BACKEND_URL = 'https://YOUR-RAILWAY-URL.up.railway.app';
```

---

## Step 7 — Deploy frontend to Netlify

1. Go to **netlify.com/drop**
2. Drag the entire `Rhythm PWA` folder onto the page
3. Netlify gives you a URL like `https://random-words-123.netlify.app`
4. Go back to Railway → add/update `FRONTEND_URL` to your Netlify URL

---

## Step 8 — Get it on your phone

1. Open your Netlify URL in **Safari** (iPhone) or **Chrome** (Android)
2. **iPhone**: Tap Share → "Add to Home Screen" → Add
3. **Android**: Tap ⋮ menu → "Add to Home Screen" → Install
4. Open from home screen — runs full-screen like a native app

---

## Testing your promo code

1. Open the app → go through onboarding
2. On the paywall, tap **"Have a promo code?"**
3. Enter `RHYTHMBETA` (or whatever code you created in Step 1c)
4. Tap Apply → you're in

To create more promo codes any time, run in Supabase SQL Editor:
```sql
INSERT INTO promo_codes (code, description, max_uses)
VALUES ('YOURCODE', 'Description', 10);
```

To see how many times a code has been used:
```sql
SELECT code, uses_count, max_uses FROM promo_codes;
```

To deactivate a code:
```sql
UPDATE promo_codes SET is_active = false WHERE code = 'YOURCODE';
```

---

## Verify everything end-to-end

```
✅ Health check:    curl https://YOUR-URL.railway.app/health
✅ Sign up in app:  email + password → creates Supabase user
✅ Promo code:      enter code → granted access
✅ Crisis flow:     tap "I feel something" → AI responds (real Claude)
✅ Check-in:        daily log saves to Supabase DB
✅ Patterns:        after 7+ check-ins, runs statistical + AI analysis
✅ Chat:            real-time Claude responses
✅ Stripe:          "Start free trial" → redirects to Stripe checkout
```
