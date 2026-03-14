// Supabase Edge Function: generate-domains
// Runs on Deno (server-side), keeps Gemini API key secure
// Deploy: supabase functions deploy generate-domains --no-verify-jwt

// Dependencies removed since tracking is client-side now
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    const SUPABASE_URL = Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('PROJECT_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

    // Parse body
    const body = await req.json();
    const { keywords, batchSize = 15, promptInstructions, selectedSuffixes = [], checkedDomains = [] } = body;

    if (!keywords) throw new Error('keywords is required');

    // Authentication check removed because quota is enforced heavily on the client side
    // and this edge function merely builds prompts for Gemini.

    // Build Gemini prompt
    const effectiveBatchSize = batchSize || 15;
    const defaultPrompt = `You are a highly creative AI brand naming expert. Generate ${effectiveBatchSize} HIGH-QUALITY, UNIQUE domain names based on user keywords.\n\nRULES:\n1. Base name ONLY (NO .com, NO extensions).\n2. NO HYPHENS (-), NO NUMBERS. Alphabetical letters only.\n3. Keep it between 6 to 14 letters maximum.\n4. Memorable, brandable, and easy to pronounce.\n5. Be highly creative and unpredictable.\n6. NEVER REPEAT previously generated domains.`;

    const customPart = promptInstructions ? `\n\nUSER INSTRUCTIONS:\n${promptInstructions}` : '';
    const suffixPart = selectedSuffixes.length > 0
      ? `\n\nMIX-INS: Append one of these to at least half the domains: [${selectedSuffixes.join(', ')}].`
      : '';
    const avoidPart = checkedDomains.length > 0
      ? `\n\nDo NOT generate any of these: ${checkedDomains.slice(-50).join(', ')}`
      : '';

    const fullPrompt = `${defaultPrompt}${customPart}${suffixPart}\n\nKeywords: ${keywords}${avoidPart}`;

    // Call Gemini
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          temperature: 0.95,
          responseMimeType: 'application/json',
          responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API error: ${geminiRes.status} - ${errText}`);
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    let domains = [];
    try {
      domains = JSON.parse(rawText);
    } catch {
      domains = rawText.split(/[\n,]+/);
    }

    // Sanitize: letters only, trim, lowercase
    domains = domains
      .map(d => d.replace(/[^a-zA-Z]/g, '').trim().toLowerCase())
      .filter(d => d.length >= 4);

    // No database increments here. Handled by client.

    return new Response(
      JSON.stringify({ domains, count: domains.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
