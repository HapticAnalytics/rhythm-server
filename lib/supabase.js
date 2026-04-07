import { createClient } from '@supabase/supabase-js';

// Service-role client — bypasses RLS, used only on the server
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Verify a user JWT from the frontend and return the user object
export async function verifyUser(token) {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// Get user profile including subscription status
export async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

// Check if user has valid access (trial, active subscription, or promo code)
export async function hasValidAccess(userId) {
  const profile = await getUserProfile(userId);
  if (!profile) return false;
  const trialActive = profile.trial_ends_at && new Date(profile.trial_ends_at) > new Date();
  const subscribed = profile.subscription_status === 'active';
  const promoAccess = profile.subscription_status === 'promo';
  return trialActive || subscribed || promoAccess;
}
