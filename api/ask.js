// KARMA backend — proxies requests to Gemini so the API key never
// reaches the browser. Deployed as a Vercel serverless function.

const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest'];
const RETRY_DELAYS_MS = [0, 800, 1800]; // waits before each attempt

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callGemini(apiKey, body, model) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  return res;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Add it in Vercel project settings.' });
    return;
  }

  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'No messages provided.' });
      return;
    }

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

    const body = {
      contents,
      generationConfig: { maxOutputTokens: 1000 }
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }

    let geminiRes, lastDetail;
    for (let i = 0; i < MODELS.length; i++) {
      if (RETRY_DELAYS_MS[i]) await sleep(RETRY_DELAYS_MS[i]);
      console.log('KARMA: attempt', i + 1, 'using model', MODELS[i]);
      geminiRes = await callGemini(apiKey, body, MODELS[i]);
      console.log('KARMA: Gemini responded with status', geminiRes.status);

      if (geminiRes.ok) break;

      lastDetail = await geminiRes.text();
      console.error('KARMA: Gemini error on attempt', i + 1, ':', lastDetail);

      // Only retry on overload/unavailable errors; anything else, fail fast.
      if (geminiRes.status !== 503 && geminiRes.status !== 429) break;
    }

    if (!geminiRes.ok) {
      res.status(503).json({
        error: "KARMA's AI is getting a lot of demand right now. Please wait a few seconds and try again.",
        detail: lastDetail
      });
      return;
    }

    const data = await geminiRes.json();
    const candidate = data && data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map(p => p.text || '').join('\n').trim()
      : '';

    if (!text) {
      console.error('KARMA: empty text, full response was:', JSON.stringify(data));
      res.status(502).json({ error: 'The AI returned an empty response. Try again.' });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    console.error('KARMA: caught exception:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
