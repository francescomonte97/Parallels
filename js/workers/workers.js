export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log('Worker pathname:', url.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      if (url.pathname === '/api/claude' && request.method === 'POST') {
        return await handleClaude(request, env);
      }

      if (url.pathname === '/api/gemini-stt' && request.method === 'POST') {
        return await handleGeminiSTT(request, env);
      }

      if (url.pathname === '/api/gemini-ocr' && request.method === 'POST') {
        return await handleGeminiOCR(request, env);
      }

      if (url.pathname === '/api/gemini-image-context' && request.method === 'POST') {
        return await handleGeminiImageContext(request, env);
      }

      if (url.pathname === '/api/elevenlabs-tts' && request.method === 'POST') {
        return await handleElevenLabsTTS(request, env);
      }

      return json(
        {
          ok: true,
          message: 'LIPU Worker attivo',
          pathname: url.pathname,
          endpoints: [
            '/api/claude',
            '/api/gemini-stt',
            '/api/gemini-ocr',
            '/api/gemini-image-context',
            '/api/elevenlabs-tts'
          ],
          env_check: {
            anthropic: Boolean(env.ANTHROPIC_API_KEY),
            gemini: Boolean(env.GEMINI_API_KEY),
            elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
            elevenlabsVoice: Boolean(env.ELEVENLABS_VOICE_ID)
          }
        },
        200
      );
    } catch (err) {
      return json(
        {
          error: String(err?.message || err || 'Errore interno Worker')
        },
        500
      );
    }
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

function extractGeminiText(data) {
  if (!data || typeof data !== 'object') return '';

  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';

  return parts
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function extractClaudeText(data) {
  if (!data || typeof data !== 'object') return '';

  const blocks = Array.isArray(data?.content) ? data.content : [];

  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

function normalizeClaudeModel(inputModel = '') {
  const safe = String(inputModel || '').trim().toLowerCase();

  if (!safe) return 'claude-sonnet-4-6';

  if (
    safe === 'haiku' ||
    safe === 'claude-haiku' ||
    safe === 'claude-3-5-haiku' ||
    safe === 'claude-3-5-haiku-latest'
  ) {
    return 'claude-haiku-4-5-20251001';
  }

  if (safe === 'sonnet' || safe === 'claude-sonnet') {
    return 'claude-sonnet-4-6';
  }

  return safe;
}

function normalizeTemperature(value, fallback = 0.7) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function normalizeMaxTokens(value, fallback = 400) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(4000, Math.floor(num)));
}

async function handleClaude(request, env) {
  const body = await request.json();
  const userMsg = String(body?.userMsg || '').trim();
  const systemText = String(body?.systemText || '').trim();
  const model = normalizeClaudeModel(body?.model);
  const temperature = normalizeTemperature(body?.temperature, 0.7);
  const maxTokens = normalizeMaxTokens(body?.max_tokens, 400);

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY mancante' }, 500);
  }

  if (!userMsg) {
    return json({ error: 'userMsg mancante' }, 400);
  }

  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemText,
    messages: [
      {
        role: 'user',
        content: userMsg
      }
    ]
  };

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  const raw = await upstream.text();

  if (!upstream.ok) {
    return json(
      {
        error: raw || 'Errore Claude',
        debug: payload
      },
      upstream.status
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json(
      {
        error: 'Risposta Claude non valida',
        raw
      },
      500
    );
  }

  const text = extractClaudeText(data);

  return json({
    text: text || '',
    stop_reason: data?.stop_reason || null,
    model: data?.model || model,
    temperature,
    max_tokens: maxTokens,
    raw_content: Array.isArray(data?.content) ? data.content : []
  });
}

async function handleGeminiSTT(request, env) {
  const body = await request.json();
  const base64Audio = String(body?.base64Audio || '');
  const mimeType = String(body?.mimeType || 'audio/webm');

  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY mancante' }, 500);
  }

  if (!base64Audio) {
    return json({ error: 'base64Audio mancante' }, 400);
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Trascrivi questo audio in italiano. Restituisci solo il testo trascritto, senza commenti, senza introduzioni, senza virgolette.'
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Audio
                }
              }
            ]
          }
        ]
      })
    }
  );

  const raw = await upstream.text();

  if (!upstream.ok) {
    return json(
      {
        error: raw || 'Errore STT Gemini'
      },
      upstream.status
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'Risposta STT Gemini non valida' }, 500);
  }

  return json({
    text: extractGeminiText(data)
  });
}

async function handleGeminiOCR(request, env) {
  const body = await request.json();
  const base64Image = String(body?.base64Image || '');
  const mimeType = String(body?.mimeType || 'image/png');

  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY mancante' }, 500);
  }

  if (!base64Image) {
    return json({ error: 'base64Image mancante' }, 400);
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Estrai tutto il testo presente nell’immagine. Restituisci solo il testo, mantenendo l’ordine di lettura. Se non c’è testo, restituisci stringa vuota.'
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    }
  );

  const raw = await upstream.text();

  if (!upstream.ok) {
    return json(
      {
        error: raw || 'Errore OCR Gemini'
      },
      upstream.status
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'Risposta OCR Gemini non valida' }, 500);
  }

  return json({
    text: extractGeminiText(data)
  });
}

async function handleGeminiImageContext(request, env) {
  const body = await request.json();
  const base64Image = String(body?.base64Image || '');
  const mimeType = String(body?.mimeType || 'image/png');

  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY mancante' }, 500);
  }

  if (!base64Image) {
    return json({ error: 'base64Image mancante' }, 400);
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `
Descrivi questa immagine in italiano in modo breve e utile per una chat.

Restituisci SOLO un JSON valido con questa struttura:
{
  "scene": "descrizione sintetica della scena",
  "visibleText": "testo visibile se presente, altrimenti stringa vuota",
  "context": "che tipo di immagine è e cosa sta mostrando",
  "mood": "tono visivo generale"
}

Regole:
- niente markdown
- niente testo fuori dal JSON
- non inventare dettagli molto specifici se non sono visibili
- se è uno screenshot o un'interfaccia, dillo chiaramente
- se c'è testo visibile, riportalo in modo sintetico
                `.trim()
              },
              {
                inlineData: {
                  mimeType,
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    }
  );

  const raw = await upstream.text();

  if (!upstream.ok) {
    return json(
      {
        error: raw || 'Errore Gemini image context'
      },
      upstream.status
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ error: 'Risposta Gemini image context non valida' }, 500);
  }

  return json({
    text: extractGeminiText(data)
  });
}

async function handleElevenLabsTTS(request, env) {
  const body = await request.json();
  const text = String(body?.text || '').trim();
  const voiceId = String(body?.voiceId || env.ELEVENLABS_VOICE_ID || '').trim();

  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: 'ELEVENLABS_API_KEY mancante' }, 500);
  }

  if (!voiceId) {
    return json({ error: 'ELEVENLABS_VOICE_ID mancante' }, 500);
  }

  if (!text) {
    return json({ error: 'text mancante' }, 400);
  }

  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': env.ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  const arrayBuffer = await upstream.arrayBuffer();

  if (!upstream.ok) {
    const errorText = new TextDecoder().decode(arrayBuffer);
    return json(
      {
        error: errorText || `Errore ElevenLabs (${upstream.status})`
      },
      upstream.status
    );
  }

  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      ...corsHeaders()
    }
  });
}