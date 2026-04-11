import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { supabase, verifyUser, hasValidAccess } from '../lib/supabase.js';
import { SPIRAL_STOPPER_SYSTEM, PATTERN_ANALYSIS_SYSTEM, CHAT_SYSTEM } from '../lib/knowledge.js';
import { computeTriggers, buildBestDayProfile } from '../lib/patterns.js';

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GET /api/ai/test — no auth, diagnose Anthropic connection ────────────────
router.get('/test', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Say "ok"' }]
    });
    res.json({ ok: true, reply: response.content[0].text, key: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING' });
  } catch (err) {
    res.json({ ok: false, status: err.status, message: err.message, key: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING' });
  }
});

// ── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await verifyUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

async function requireAccess(req, res, next) {
  const ok = await hasValidAccess(req.user.id);
  if (!ok) return res.status(402).json({ error: 'subscription_required' });
  next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mostCommon(arr) {
  if (!arr?.length) return 'none logged yet';
  const counts = arr.reduce((a, v) => ({ ...a, [v]: (a[v] || 0) + 1 }), {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]).join(', ');
}

function checkinContext(c) {
  if (!c) return 'no check-in today';
  const parts = [`sleep ${c.sleep_hours || '?'}h`];
  if (c.caffeine_timing) parts.push(`caffeine: ${c.caffeine_timing}`);
  if (c.stress_level) parts.push(`stress: ${c.stress_level}/5`);
  if (c.alcohol_units > 0) parts.push(`alcohol: ${c.alcohol_units} units`);
  return parts.join(', ');
}

// ── POST /api/ai/spiral-stopper ──────────────────────────────────────────────
// Called when user goes through the crisis flow. Streams the response.

router.post('/spiral-stopper', requireAuth, requireAccess, async (req, res) => {
  const { episodeData, episodeId } = req.body;

  const [profileRes, episodesRes, checkinsRes] = await Promise.all([
    supabase.from('profiles').select('conditions').eq('id', req.user.id).single(),
    supabase.from('episodes').select('sensation_types,intensity,created_at').eq('user_id', req.user.id)
      .order('created_at', { ascending: false }).limit(20),
    supabase.from('daily_checkins').select('*').eq('user_id', req.user.id)
      .order('date', { ascending: false }).limit(7)
  ]);

  const conditions = profileRes.data?.conditions?.join(', ') || 'not specified';
  const episodes = episodesRes.data || [];
  const checkins = checkinsRes.data || [];
  const today = new Date().toISOString().split('T')[0];
  const todayCheckin = checkins.find(c => c.date === today);
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

  const userMessage = `
The user is having a cardiac episode RIGHT NOW and needs immediate, specific support.

WHAT THEY'RE FEELING:
- Sensation(s): ${episodeData.sensationTypes?.join(', ') || 'palpitations'}
- Intensity: ${episodeData.intensity || '?'}/5
- Duration: ${episodeData.durationCategory || 'ongoing'}
- Time: ${timeOfDay}

THEIR HISTORY:
- Conditions: ${conditions}
- Total logged episodes: ${episodes.length}
- Episodes in last 7 days: ${episodes.filter(e => new Date(e.created_at) > new Date(Date.now() - 7*864e5)).length}
- Most common sensations overall: ${mostCommon(episodes.flatMap(e => e.sensation_types || []))}
- Today's check-in: ${checkinContext(todayCheckin)}

Respond immediately. Be specific to their sensations. 3-4 sentences maximum.
`.trim();

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering on Railway

  let fullResponse = '';

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system: SPIRAL_STOPPER_SYSTEM,
      messages: [{ role: 'user', content: userMessage }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullResponse += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

    // Persist AI response to episode record
    if (episodeId) {
      await supabase.from('episodes').update({ ai_response: fullResponse }).eq('id', episodeId);
    }

  } catch (err) {
    console.error('Spiral stopper error:', err.message);
    const fallback = "Focus right here. Breathe out slowly for 6 full seconds — longer than you breathe in. Your heart is doing exactly what it's supposed to do. Tell me what you feel after that breath.";
    res.write(`data: ${JSON.stringify({ text: fallback, done: true })}\n\n`);
    res.end();
  }
});

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
// Multi-turn chat. Receives { messages: [{role, content}] }

router.post('/chat', requireAuth, requireAccess, async (req, res) => {
  const { messages, userContext } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Anthropic requires messages to start with role:'user' and alternate user/assistant.
  // Strip any leading assistant messages (can happen from older frontend builds).
  // Also ensure strict alternation by deduplicating consecutive same-role messages.
  const rawMessages = messages.map(m => ({ role: m.role, content: String(m.content || '') }));
  const validMessages = [];
  for (const msg of rawMessages) {
    const last = validMessages[validMessages.length - 1];
    if (last && last.role === msg.role) {
      // Merge consecutive same-role messages
      last.content += '\n' + msg.content;
    } else {
      validMessages.push({ ...msg });
    }
  }
  // Drop leading assistant messages
  while (validMessages.length && validMessages[0].role !== 'user') validMessages.shift();

  if (!validMessages.length) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ text: "I'm here. What's going on?", done: true })}\n\n`);
    res.end();
    return;
  }

  // Fetch today's context
  const today = new Date().toISOString().split('T')[0];
  const { data: todayCheckin } = await supabase
    .from('daily_checkins').select('*').eq('user_id', req.user.id).eq('date', today).single();

  const systemWithContext = `${CHAT_SYSTEM}\n\nUSER'S TODAY CHECK-IN: ${checkinContext(todayCheckin)}${userContext ? '\n\n' + userContext : ''}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemWithContext,
      messages: validMessages
    });

    const text = response.content?.[0]?.text || "I'm here with you.";
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ text, done: true })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Chat error:', err.status, err.message);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ text: "I'm having trouble connecting right now. Try again in a moment — I'm here.", done: true })}\n\n`);
    res.end();
  }
});

// ── POST /api/ai/pattern-analysis ────────────────────────────────────────────
// Runs full pattern analysis for the Patterns screen.

router.post('/pattern-analysis', requireAuth, requireAccess, async (req, res) => {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 864e5).toISOString();

  const [episodesRes, checkinsRes, profileRes] = await Promise.all([
    supabase.from('episodes').select('*').eq('user_id', req.user.id)
      .gte('created_at', sixtyDaysAgo).order('created_at', { ascending: false }),
    supabase.from('daily_checkins').select('*').eq('user_id', req.user.id)
      .gte('date', sixtyDaysAgo.split('T')[0]).order('date', { ascending: false }),
    supabase.from('profiles').select('conditions').eq('id', req.user.id).single()
  ]);

  const episodes = episodesRes.data || [];
  const checkins = checkinsRes.data || [];
  const conditions = profileRes.data?.conditions?.join(', ') || 'not specified';

  if (checkins.length < 7) {
    return res.json({
      hasEnoughData: false,
      daysLogged: checkins.length,
      daysNeeded: 7 - checkins.length,
      message: `Log ${7 - checkins.length} more daily check-ins before your patterns become visible.`
    });
  }

  // Run our own stats engine first
  const localAnalysis = computeTriggers(episodes, checkins);
  const bestDay = buildBestDayProfile(episodes, checkins);

  // Then ask Claude to narrate and deepen it
  const userMessage = `
Analyze this user's cardiac symptom data.

CONDITIONS: ${conditions}
DATA SUMMARY (last 60 days):
- Episodes: ${episodes.length}
- Check-in days: ${checkins.length}
- Data quality: ${localAnalysis.dataQuality}

OUR STATISTICAL ENGINE FOUND:
${localAnalysis.triggers.length
  ? localAnalysis.triggers.map(t =>
      `- ${t.label}: ${t.relativeRisk}x relative risk (${t.rateWith}% episode rate WITH vs ${t.rateWithout}% WITHOUT, n=${t.sampleWith}/${t.sampleWithout}, confidence: ${t.confidence})`
    ).join('\n')
  : '- No significant correlations found yet'
}

FACTORS WITH NO CORRELATION:
${localAnalysis.noCorrelation?.length ? localAnalysis.noCorrelation.join(', ') : 'None confirmed yet'}

BEST DAYS PROFILE: ${bestDay.length ? bestDay.join(', ') : 'still building'}

RAW EPISODE DATA: ${JSON.stringify(episodes.slice(0, 30).map(e => ({
  date: e.created_at.split('T')[0],
  sensations: e.sensation_types,
  intensity: e.intensity,
  hour: new Date(e.created_at).getHours()
})))}

RAW CHECK-IN DATA: ${JSON.stringify(checkins.slice(0, 30).map(c => ({
  date: c.date,
  sleep: c.sleep_hours,
  caffeine: c.caffeine_timing,
  stress: c.stress_level,
  alcohol: c.alcohol_units,
  hydration: c.hydration,
  magnesium: c.magnesium_taken,
  leftSide: c.left_side_lying
})))}

Respond as JSON only — no markdown, no explanation outside the JSON:
{
  "topTriggers": [{"factor":"string","label":"string","relativeRisk":number,"description":"string one sentence specific to this user","confidence":"low|medium|high"}],
  "noCorrelation": ["label1","label2"],
  "bestDayProfile": ["factor1","factor2"],
  "worstDayProfile": ["factor1","factor2"],
  "keyInsight": "string — the single most important finding, specific with numbers",
  "actionableChange": "string — one concrete testable change for next week",
  "dataQuality": "${localAnalysis.dataQuality}"
}
`.trim();

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: PATTERN_ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }]
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const aiAnalysis = JSON.parse(jsonMatch[0]);

    // Merge our stats (authoritative numbers) with Claude's narrative
    const result = {
      hasEnoughData: true,
      topTriggers: localAnalysis.triggers.map(t => ({
        ...t,
        description: aiAnalysis.topTriggers?.find(a => a.factor === t.factor)?.description || ''
      })),
      noCorrelation: localAnalysis.noCorrelation || [],
      bestDayProfile: aiAnalysis.bestDayProfile || bestDay,
      worstDayProfile: aiAnalysis.worstDayProfile || [],
      keyInsight: aiAnalysis.keyInsight,
      actionableChange: aiAnalysis.actionableChange,
      dataQuality: localAnalysis.dataQuality,
      daysAnalyzed: checkins.length,
      episodesAnalyzed: episodes.length,
      generatedAt: new Date().toISOString()
    };

    // Cache to Supabase
    await supabase.from('pattern_snapshots').insert({
      user_id: req.user.id,
      top_triggers: result.topTriggers,
      best_day_factors: result.bestDayProfile,
      worst_day_factors: result.worstDayProfile,
      insight_text: result.keyInsight,
      actionable_change: result.actionableChange,
      episodes_this_week: episodes.filter(e => new Date(e.created_at) > new Date(Date.now() - 7*864e5)).length,
      episodes_last_week: episodes.filter(e => {
        const d = new Date(e.created_at);
        return d > new Date(Date.now() - 14*864e5) && d <= new Date(Date.now() - 7*864e5);
      }).length,
      data_quality: result.dataQuality,
      correlations: result
    });

    res.json(result);

  } catch (err) {
    console.error('Pattern analysis error:', err.message);
    // Return our local stats without AI narration as fallback
    res.json({
      hasEnoughData: true,
      topTriggers: localAnalysis.triggers,
      noCorrelation: localAnalysis.noCorrelation || [],
      bestDayProfile: bestDay,
      worstDayProfile: [],
      keyInsight: localAnalysis.triggers[0]
        ? `Your strongest signal: episodes are ${localAnalysis.triggers[0].relativeRisk}x more common with ${localAnalysis.triggers[0].label}.`
        : 'Keep logging — patterns will appear with more data.',
      actionableChange: 'Continue daily check-ins to build your pattern picture.',
      dataQuality: localAnalysis.dataQuality,
      daysAnalyzed: checkins.length,
      episodesAnalyzed: episodes.length,
      generatedAt: new Date().toISOString()
    });
  }
});

// ── POST /api/ai/weekly-insight ───────────────────────────────────────────────

router.post('/weekly-insight', requireAuth, requireAccess, async (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7*864e5).toISOString();
  const fourteenDaysAgo = new Date(Date.now() - 14*864e5).toISOString();

  const [thisWeekRes, lastWeekRes, snapshotRes, checkinsRes] = await Promise.all([
    supabase.from('episodes').select('id').eq('user_id', req.user.id).gte('created_at', sevenDaysAgo),
    supabase.from('episodes').select('id').eq('user_id', req.user.id)
      .gte('created_at', fourteenDaysAgo).lt('created_at', sevenDaysAgo),
    supabase.from('pattern_snapshots').select('*').eq('user_id', req.user.id)
      .order('generated_at', { ascending: false }).limit(1).single(),
    supabase.from('daily_checkins').select('sleep_hours,stress_level').eq('user_id', req.user.id)
      .gte('date', sevenDaysAgo.split('T')[0]).order('date', { ascending: false })
  ]);

  const thisWeek = thisWeekRes.data?.length || 0;
  const lastWeek = lastWeekRes.data?.length || 0;
  const snapshot = snapshotRes.data;
  const checkins = checkinsRes.data || [];

  const avgSleep = checkins.length
    ? (checkins.reduce((s, c) => s + (c.sleep_hours || 0), 0) / checkins.length).toFixed(1)
    : 'unknown';
  const avgStress = checkins.length
    ? (checkins.reduce((s, c) => s + (c.stress_level || 0), 0) / checkins.length).toFixed(1)
    : 'unknown';

  const userMessage = `
Generate a warm, specific weekly check-in for a cardiac anxiety app user.

THIS WEEK: ${thisWeek} episodes (last week: ${lastWeek})
TREND: ${thisWeek < lastWeek ? `down ${lastWeek - thisWeek}` : thisWeek > lastWeek ? `up ${thisWeek - lastWeek}` : 'same'}
AVG SLEEP THIS WEEK: ${avgSleep}h
AVG STRESS THIS WEEK: ${avgStress}/5
TOP PATTERN FOUND: ${snapshot?.top_triggers?.[0] ? `${snapshot.top_triggers[0].label} (${snapshot.top_triggers[0].relativeRisk}x risk)` : 'still analyzing'}
KEY INSIGHT: ${snapshot?.insight_text || 'not enough data yet'}
SUGGESTED CHANGE: ${snapshot?.actionable_change || 'keep logging daily'}

Write exactly 3-4 sentences:
1. Specific acknowledgment of their week using real numbers — no generic phrases
2. The most useful pattern finding from their actual data
3. One concrete thing to try or continue next week
4. Genuine, specific encouragement — NOT "you're doing great!" — something actually relevant to their situation

Tone: like a knowledgeable friend, not a health app. Warm, direct, real.
`.trim();

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      system: SPIRAL_STOPPER_SYSTEM,
      messages: [{ role: 'user', content: userMessage }]
    });

    res.json({ insight: message.content[0].text, thisWeek, lastWeek });

  } catch (err) {
    const trend = thisWeek < lastWeek ? 'down' : thisWeek > lastWeek ? 'up' : 'steady';
    res.json({
      insight: `You logged ${thisWeek} episodes this week, ${trend} from ${lastWeek} last week. ${snapshot?.insight_text || 'Keep logging to reveal your patterns.'} ${snapshot?.actionable_change || 'Consistency is the key — every check-in adds resolution to your picture.'}`,
      thisWeek,
      lastWeek
    });
  }
});

export default router;
