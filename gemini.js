import { supabase } from './lib/supabase.js';

/**
 * Calls the Supabase Edge Function `generate-domains`.
 * The edge function holds the Gemini API key securely server-side.
 * @param {object} params - { keywords, batchSize, promptInstructions, selectedSuffixes, checkedDomains }
 * @param {object|null} session - Supabase session (null for guest)
 */
export async function generateDomains(params, session) {
  const headers = { 'Content-Type': 'application/json' };
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  const { data, error } = await supabase.functions.invoke('generate-domains', {
    body: params,
    headers,
  });

  if (error) throw new Error(error.message || 'Edge function error');
  if (!data || !data.domains) throw new Error('No domains returned from server');

  return data.domains; // array of strings
}
