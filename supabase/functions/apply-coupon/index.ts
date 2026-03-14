// Supabase Edge Function: apply-coupon
// Validates a coupon code and applies it to the user's profile
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL');
    const SERVICE_KEY  = Deno.env.get('PROJECT_SERVICE_KEY');
    if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing env vars');

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Verify user JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Authentication required');
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) throw new Error('Invalid token');

    const { code } = await req.json();
    if (!code) throw new Error('Coupon code required');

    // Fetch coupon
    const { data: coupon, error: couponErr } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', code.toUpperCase().trim())
      .single();

    if (couponErr || !coupon) {
      return new Response(JSON.stringify({ error: 'Invalid coupon code' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!coupon.is_active) {
      return new Response(JSON.stringify({ error: 'This coupon has expired' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (coupon.uses >= coupon.max_uses) {
      return new Response(JSON.stringify({ error: 'Coupon has reached its usage limit' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + coupon.duration_days);

    // Apply plan to profile
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({
        plan: coupon.plan,
        plan_expires_at: expiresAt.toISOString(),
        billing_period_start: new Date().toISOString(),
        ai_sessions_month: 0,
        manual_sessions_month: 0,
      })
      .eq('id', user.id);

    if (updateErr) throw new Error('Failed to apply coupon: ' + updateErr.message);

    // Increment coupon uses
    await supabase.from('coupons')
      .update({ uses: coupon.uses + 1 })
      .eq('code', coupon.code);

    // Return updated profile
    const { data: profile } = await supabase
      .from('profiles').select('*').eq('id', user.id).single();

    return new Response(
      JSON.stringify({ success: true, plan: coupon.plan, expiresAt: expiresAt.toISOString(), profile }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
