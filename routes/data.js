/**
 * Data routes — all CRUD for episodes and check-ins.
 * The PWA calls these instead of touching Supabase directly,
 * so the service key never leaves the server.
 */
import express from 'express';
import { supabase, verifyUser } from '../lib/supabase.js';

const router = express.Router();

// ── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

// ── Episodes ─────────────────────────────────────────────────────────────────

// GET /api/data/episodes?limit=50&offset=0
router.get('/episodes', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ episodes: data, count: data.length });
});

// POST /api/data/episodes — save a new episode
router.post('/episodes', requireAuth, async (req, res) => {
  const {
    sensation_types, symptoms, intensity,
    duration, duration_category,
    body_state, body_state_other,
    triggers, triggers_other,
    notes, worried_flag,
    time_of_day, day_of_week,
    // legacy fields
    activity_before, position, trigger_tags, episode_notes,
    created_at
  } = req.body;

  const { data, error } = await supabase
    .from('episodes')
    .insert({
      user_id: req.user.id,
      sensation_types: sensation_types || [],
      symptoms: symptoms || sensation_types || [],
      intensity,
      duration: duration || duration_category || null,
      duration_category: duration_category || duration || null,
      body_state: body_state || [],
      body_state_other: body_state_other || null,
      triggers: triggers || [],
      triggers_other: triggers_other || null,
      notes: notes || episode_notes || null,
      worried_flag: worried_flag || null,
      time_of_day: time_of_day || null,
      day_of_week: day_of_week || null,
      // legacy
      trigger_tags: trigger_tags || [],
      activity_before: activity_before || null,
      position: position || null,
      created_at: created_at || new Date().toISOString()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ episode: data });
});

// PATCH /api/data/episodes/:id — update (e.g. add ai_response, mark resolved)
router.patch('/episodes/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  // Safety: remove user_id from updates
  delete updates.user_id;
  delete updates.id;

  const { data, error } = await supabase
    .from('episodes')
    .update(updates)
    .eq('id', id)
    .eq('user_id', req.user.id) // ensure ownership
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ episode: data });
});

// POST /api/data/episodes/sync — bulk upsert for offline sync
router.post('/episodes/sync', requireAuth, async (req, res) => {
  const { episodes } = req.body;
  if (!Array.isArray(episodes) || !episodes.length) return res.json({ synced: 0 });

  const rows = episodes.map(e => ({
    ...e,
    user_id: req.user.id, // enforce ownership
    id: e.id || undefined  // let Supabase generate if no id
  }));

  const { data, error } = await supabase
    .from('episodes')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false })
    .select('id');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ synced: data.length, ids: data.map(r => r.id) });
});

// ── Daily Check-ins ──────────────────────────────────────────────────────────

// GET /api/data/checkins?days=30
router.get('/checkins', requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('daily_checkins')
    .select('*')
    .eq('user_id', req.user.id)
    .gte('date', cutoff)
    .order('date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ checkins: data });
});

// POST /api/data/checkins — upsert today's check-in
router.post('/checkins', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const checkin = {
    user_id: req.user.id,
    date: req.body.date || today,
    sleep_hours: req.body.sleep_hours,
    sleep_quality: req.body.sleep_quality,
    caffeine_timing: req.body.caffeine_timing,
    stress_level: req.body.stress_level,
    exercise_level: req.body.exercise_level,
    digestion: req.body.digestion,
    hydration: req.body.hydration,
    alcohol_units: req.body.alcohol_units ?? 0,
    magnesium_taken: req.body.magnesium_taken ?? false,
    left_side_lying: req.body.left_side_lying ?? false,
    meal_before_episode: req.body.meal_before_episode ?? false,
    exercise_within_2hrs: req.body.exercise_within_2hrs ?? false
  };

  const { data, error } = await supabase
    .from('daily_checkins')
    .upsert(checkin, { onConflict: 'user_id,date' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ checkin: data });
});

// POST /api/data/checkins/sync — bulk upsert for offline sync
router.post('/checkins/sync', requireAuth, async (req, res) => {
  const { checkins } = req.body;
  if (!Array.isArray(checkins) || !checkins.length) return res.json({ synced: 0 });

  const rows = checkins.map(c => ({ ...c, user_id: req.user.id }));

  const { data, error } = await supabase
    .from('daily_checkins')
    .upsert(rows, { onConflict: 'user_id,date' })
    .select('id,date');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ synced: data.length });
});

export default router;
