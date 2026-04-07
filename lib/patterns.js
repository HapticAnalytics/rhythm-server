/**
 * Server-side pattern analysis engine.
 * Computes relative risk for each lifestyle factor against episode days.
 * Returns structured data that can be used directly or passed to Claude for narration.
 */

const FACTORS = [
  {
    key: 'poor_sleep',
    label: 'Poor sleep (<6h)',
    test: c => c.sleep_hours != null && c.sleep_hours < 6,
    inverse: 'Good sleep (6h+)'
  },
  {
    key: 'high_caffeine',
    label: 'Afternoon / evening caffeine',
    test: c => c.caffeine_timing === 'afternoon' || c.caffeine_timing === 'evening',
    inverse: 'No late caffeine'
  },
  {
    key: 'high_stress',
    label: 'High stress (4–5/5)',
    test: c => c.stress_level >= 4,
    inverse: 'Low-moderate stress'
  },
  {
    key: 'alcohol',
    label: 'Alcohol consumed',
    test: c => c.alcohol_units > 0,
    inverse: 'No alcohol'
  },
  {
    key: 'low_hydration',
    label: 'Poor hydration',
    test: c => c.hydration === 1,
    inverse: 'Good hydration'
  },
  {
    key: 'no_magnesium',
    label: 'No magnesium supplement',
    test: c => c.magnesium_taken === false,
    inverse: 'Took magnesium'
  },
  {
    key: 'left_side_lying',
    label: 'Slept / rested on left side',
    test: c => c.left_side_lying === true,
    inverse: 'Not on left side'
  },
  {
    key: 'meal_before',
    label: 'Large meal before episode',
    test: c => c.meal_before_episode === true,
    inverse: 'No large meal before'
  }
];

const MIN_SAMPLE_EACH_GROUP = 4; // minimum days in WITH and WITHOUT groups
const MIN_RELATIVE_RISK = 1.3;   // minimum meaningful signal

export function computeTriggers(episodes, checkins) {
  if (!episodes.length || !checkins.length) return { triggers: [], dataQuality: 'insufficient' };

  // Build a set of dates with episodes (also include next-day since triggers often precede by a day)
  const episodeDates = new Set();
  episodes.forEach(e => {
    const d = e.created_at.split('T')[0];
    episodeDates.add(d);
    // Next day — some triggers (alcohol, poor sleep) manifest next day
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    episodeDates.add(next.toISOString().split('T')[0]);
  });

  const results = [];

  for (const factor of FACTORS) {
    const withFactor = checkins.filter(c => factor.test(c));
    const withoutFactor = checkins.filter(c => !factor.test(c));

    if (withFactor.length < MIN_SAMPLE_EACH_GROUP || withoutFactor.length < MIN_SAMPLE_EACH_GROUP) {
      continue; // not enough data to compare
    }

    const rateWith = withFactor.filter(c => episodeDates.has(c.date)).length / withFactor.length;
    const rateWithout = withoutFactor.filter(c => episodeDates.has(c.date)).length / withoutFactor.length;

    const relativeRisk = rateWithout > 0 ? rateWith / rateWithout : rateWith > 0 ? 5 : 1;

    const confidence =
      withFactor.length >= 15 && withoutFactor.length >= 15 ? 'high' :
      withFactor.length >= 8  && withoutFactor.length >= 8  ? 'medium' : 'low';

    results.push({
      factor: factor.key,
      label: factor.label,
      relativeRisk: Math.round(relativeRisk * 10) / 10,
      rateWith: Math.round(rateWith * 100),
      rateWithout: Math.round(rateWithout * 100),
      sampleWith: withFactor.length,
      sampleWithout: withoutFactor.length,
      confidence
    });
  }

  // Sort by relative risk descending, filter to meaningful signals
  const triggers = results
    .filter(r => r.relativeRisk >= MIN_RELATIVE_RISK)
    .sort((a, b) => b.relativeRisk - a.relativeRisk)
    .slice(0, 5);

  // Also return factors with NO correlation (useful to know)
  const noCorrelation = results
    .filter(r => r.relativeRisk < 1.1 && r.sampleWith >= MIN_SAMPLE_EACH_GROUP)
    .map(r => r.label);

  const dataQuality =
    checkins.length >= 30 ? 'excellent' :
    checkins.length >= 14 ? 'good' :
    checkins.length >= 7  ? 'building' : 'insufficient';

  return { triggers, noCorrelation, dataQuality, daysAnalyzed: checkins.length, episodesAnalyzed: episodes.length };
}

export function buildBestDayProfile(episodes, checkins) {
  if (checkins.length < 7) return [];

  const episodeDates = new Set(episodes.map(e => e.created_at.split('T')[0]));
  const bestDays = checkins.filter(c => !episodeDates.has(c.date));
  if (!bestDays.length) return [];

  const profile = [];
  const avgSleep = bestDays.reduce((s, c) => s + (c.sleep_hours || 0), 0) / bestDays.length;
  if (avgSleep >= 7) profile.push(`${avgSleep.toFixed(1)}h average sleep`);

  const noCaffeineLate = bestDays.filter(c => c.caffeine_timing === 'none' || c.caffeine_timing === 'morning').length / bestDays.length;
  if (noCaffeineLate > 0.7) profile.push('No afternoon caffeine');

  const lowStress = bestDays.filter(c => c.stress_level <= 2).length / bestDays.length;
  if (lowStress > 0.5) profile.push('Stress ≤2/5');

  const magnesium = bestDays.filter(c => c.magnesium_taken).length / bestDays.length;
  if (magnesium > 0.6) profile.push('Took magnesium');

  return profile;
}
