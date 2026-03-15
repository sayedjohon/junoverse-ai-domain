import { supabase } from './lib/supabase.js';

// ============================================
// Plan Definitions
// ============================================
export const PLANS = {
  guest: {
    label: 'Guest',        monthly: false,
    ai_per_month: 0,       ai_max: 0,      target_max: 0,
    manual_per_month: Infinity,   manual_max: 1,
  },
  free: {
    label: 'Free',         monthly: false,
    ai_per_month: 3,       ai_max: 15,     target_max: 5,
    manual_per_month: Infinity,  manual_max: 3,
  },
  starter: {
    label: 'Starter',      monthly: true,
    price: 9,              period: '2 months',
    ai_per_month: 5,       ai_max: 60,     target_max: 10,
    manual_per_month: 10,  manual_max: 60,
  },
  hustler: {
    label: 'Hustler',      monthly: true,
    price: 29,             period: '/year',
    ai_per_month: 10,      ai_max: 100,    target_max: 20,
    manual_per_month: 20,  manual_max: 100,
  },
  builder: {
    label: 'Builder',      monthly: true,   popular: true,
    price: 59,             period: '/year',
    ai_per_month: 30,      ai_max: 50,      target_max: 20,
    manual_per_month: Infinity, manual_max: 100,
  },
  pro: {
    label: 'Pro',          monthly: true,
    price: 99,             period: '/year',
    ai_per_month: 100,     ai_max: 150,     target_max: 100,
    manual_per_month: Infinity, manual_max: 500,
  },
  agency: {
    label: 'Agency',       monthly: true,
    price: 199,            period: '/year',
    ai_per_month: 250,     ai_max: 300,     target_max: Infinity,
    manual_per_month: Infinity, manual_max: Infinity,
  },
  enterprise: {
    label: 'Enterprise',   monthly: false,
    ai_per_month: Infinity, ai_max: Infinity, target_max: Infinity,
    manual_per_month: Infinity, manual_max: Infinity,
  },
};

// ============================================
// Guest Tracking (localStorage)
// ============================================
const G_AI  = 'juno_guest_ai';
const G_MAN = 'juno_guest_manual';
export function getGuestUsage() {
  return {
    ai:     parseInt(localStorage.getItem(G_AI)  || '0'),
    manual: parseInt(localStorage.getItem(G_MAN) || '0'),
  };
}
export function incrementGuestAi()     { localStorage.setItem(G_AI,  getGuestUsage().ai     + 1); }
export function incrementGuestManual() { localStorage.setItem(G_MAN, getGuestUsage().manual + 1); }

// ============================================
// Profile Helpers
// ============================================
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

/** Returns the active plan key, accounting for expiry */
export function getEffectivePlan(profile) {
  if (!profile) return 'guest';
  const plan = profile.plan || 'free';
  if (plan === 'free') return 'free';
  if (profile.plan_expires_at && new Date(profile.plan_expires_at) < new Date()) return 'free';
  return plan;
}

/** Returns usage counters, resetting if billing month elapsed */
function getMonthlyUsage(profile) {
  let ai     = profile.ai_sessions_month     || 0;
  let manual = profile.manual_sessions_month || 0;
  if (profile.billing_period_start) {
    const days = (Date.now() - new Date(profile.billing_period_start)) / 86_400_000;
    if (days >= 30) { ai = 0; manual = 0; }
  }
  return { ai, manual };
}

// ============================================
// Quota Checks
// ============================================
export function canAiSearch(profile) {
  if (!profile) return getGuestUsage().ai < PLANS.guest.ai_per_month;
  const plan = getEffectivePlan(profile);
  const limits = PLANS[plan];
  if (limits.ai_per_month === Infinity) return true;
  if (!limits.monthly) return (profile.ai_sessions_month || 0) < limits.ai_per_month;
  return getMonthlyUsage(profile).ai < limits.ai_per_month;
}

export function canManualSearch(profile) {
  if (!profile) return getGuestUsage().manual < PLANS.guest.manual_per_month;
  const plan = getEffectivePlan(profile);
  const limits = PLANS[plan];
  if (limits.manual_per_month === Infinity) return true;
  if (!limits.monthly) return (profile.manual_sessions_month || 0) < limits.manual_per_month;
  return getMonthlyUsage(profile).manual < limits.manual_per_month;
}

export function getMaxDomains(profile, mode) {
  const plan = getEffectivePlan(profile);
  const limits = PLANS[plan] || PLANS.free;
  return mode === 'ai' ? limits.ai_max : limits.manual_max;
}

// ============================================
// Remaining / Display
// ============================================
export function getRemaining(profile) {
  if (!profile) {
    const { ai, manual } = getGuestUsage();
    return {
      ai:      Math.max(0, PLANS.guest.ai_per_month  - ai),
      manual:  Math.max(0, PLANS.guest.manual_per_month - manual),
      aiMax:   PLANS.guest.ai_max,
      manualMax: PLANS.guest.manual_max,
      plan: 'guest', planLabel: 'Guest',
    };
  }
  const plan   = getEffectivePlan(profile);
  const limits = PLANS[plan] || PLANS.free;
  const { ai: aiUsed, manual: manUsed } = getMonthlyUsage(profile);
  const aiRem  = limits.ai_per_month     === Infinity ? Infinity : Math.max(0, limits.ai_per_month     - aiUsed);
  const manRem = limits.manual_per_month === Infinity ? Infinity : Math.max(0, limits.manual_per_month - manUsed);
  return {
    ai:       aiRem  === Infinity ? '∞' : aiRem,
    manual:   manRem === Infinity ? '∞' : manRem,
    aiMax:    limits.ai_max,
    manualMax: limits.manual_max,
    plan, planLabel: limits.label,
    expiresAt: profile.plan_expires_at,
  };
}

// ============================================
// DB Increments
// ============================================
export async function incrementAiSession(userId, profile) {
  const used = (profile.ai_sessions_month || 0) + 1;
  await supabase.from('profiles').update({ ai_sessions_month: used }).eq('id', userId);
}

export async function incrementManualSession(userId, profile) {
  const used = (profile.manual_sessions_month || 0) + 1;
  await supabase.from('profiles').update({ manual_sessions_month: used }).eq('id', userId);
}
