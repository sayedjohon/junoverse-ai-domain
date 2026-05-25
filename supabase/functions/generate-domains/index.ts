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
    const NVIDIA_API_KEY = Deno.env.get('NVIDIA_API_KEY');
    const SUPABASE_URL = Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('PROJECT_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not configured');

    // Parse body
    const body = await req.json();
    const { keywords, batchSize = 15, promptInstructions, selectedSuffixes = [], checkedDomains = [] } = body;

    if (!keywords) throw new Error('keywords is required');

    // Authentication check removed because quota is enforced heavily on the client side
    // and this edge function merely builds prompts for the AI.

    // Build Nvidia prompt
    const effectiveBatchSize = batchSize || 15;
    const defaultPrompt = `You are a highly creative AI brand naming expert. Generate ${effectiveBatchSize} HIGH-QUALITY, UNIQUE domain names based on user keywords.\n\nRULES:\n1. Base name ONLY (NO .com, NO extensions).\n2. NO HYPHENS (-), NO NUMBERS. Alphabetical letters only.\n3. Keep it between 6 to 14 letters maximum.\n4. Memorable, brandable, and easy to pronounce.\n5. Be highly creative and unpredictable.\n6. NEVER REPEAT previously generated domains.\n7. Return ONLY a valid JSON array of strings containing the domain names. Do not include markdown code block backticks (e.g. no \`\`\`json). Just the raw JSON. Example: ["domain1", "domain2"]`;

    const customPart = promptInstructions ? `\n\nUSER INSTRUCTIONS:\n${promptInstructions}` : '';
    const suffixPart = selectedSuffixes.length > 0
      ? `\n\nMIX-INS: Append one of these to at least half the domains: [${selectedSuffixes.join(', ')}].`
      : '';
    const avoidPart = checkedDomains.length > 0
      ? `\n\nDo NOT generate any of these: ${checkedDomains.slice(-50).join(', ')}`
      : '';

    const fullPrompt = `${defaultPrompt}${customPart}${suffixPart}\n\nKeywords: ${keywords}${avoidPart}`;

    const MODELS = [
      'google/gemma-3n-e2b-it',
      'google/gemma-3-12b-it',
      'meta/llama-3.1-8b-instruct',
      'meta/llama-3.3-70b-instruct',
      'mistralai/mistral-large-2-instruct'
    ];

    let domains = [];
    let lastError = null;

    for (const model of MODELS) {
      try {
        console.log(`Trying NVIDIA model: ${model}...`);
        const nvidiaUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';
        const nvidiaRes = await fetch(nvidiaUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'user', content: fullPrompt }
            ],
            temperature: 0.20,
            top_p: 0.70,
            max_tokens: 512,
          }),
        });

        if (!nvidiaRes.ok) {
          const errText = await nvidiaRes.text();
          throw new Error(`NVIDIA API error for ${model}: ${nvidiaRes.status} - ${errText}`);
        }

        const nvidiaData = await nvidiaRes.json();
        const rawText = nvidiaData?.choices?.[0]?.message?.content;
        if (!rawText) throw new Error(`Empty response from NVIDIA API model ${model}`);

        // Parse domains
        try {
          const cleanText = rawText.replace(/```json|```/g, '').trim();
          domains = JSON.parse(cleanText);
        } catch {
          domains = rawText.split(/[\n,]+/);
        }

        if (domains && domains.length > 0) {
          console.log(`Successfully generated domains using model ${model}`);
          break; // Success! Exit the loop.
        }
      } catch (err) {
        console.warn(`Model ${model} failed: ${err.message}`);
        lastError = err;
      }
    }

    if (domains.length === 0) {
      throw lastError || new Error('All NVIDIA models failed to generate domains.');
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
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
