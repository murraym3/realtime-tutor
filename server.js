// server.js — serves /public, JSON /translate, and JSON /chat (bot reply).
// Logs per-call token usage & estimated cost for visibility.

import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.use(express.json());

// ---------------- Pages ----------------
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/test-api', (_req, res) => res.sendFile(path.join(publicDir, 'test-api.html')));

// ---------------- OpenAI config ----------------
const API_KEY    = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.TEXT_MODEL || 'gpt-4o-mini';

if (!API_KEY) console.warn('WARNING: Missing OPENAI_API_KEY in .env');

// Price constants (text tokens) for rough logging
const INPUT_RATE_USD  = 0.60 / 1e6;
const OUTPUT_RATE_USD = 2.40 / 1e6;

// ---------------- /translate ----------------
app.post('/translate', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY in .env' });

    const { text, mode } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Missing text' });

    const styleLine = (mode === 'literal')
      ? 'Translate as literally as possible while still grammatical.'
      : 'Translate naturally and idiomatically with concise, conversational phrasing.';

    const sys = `
You are an EN↔ES translator. Detect whether the user's text is English or Spanish.
${styleLine}
Return ONLY a JSON object with keys:
- "src": verbatim source text
- "tgt": translation into the other language (EN→ES or ES→EN)
`.trim();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_TEXT,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: text }
        ]
      })
    });

    if (!r.ok) {
      const detailText = await r.text();
      console.error('OpenAI /chat/completions error:', r.status, detailText);
      return res.status(500).json({ error: 'OpenAI error', detail: detailText });
    }

    const json = await r.json();
    const usage = json?.usage || {};
    const inTok  = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const estCost = inTok * INPUT_RATE_USD + outTok * OUTPUT_RATE_USD;
    console.log(`/translate usage -> in:${inTok} out:${outTok} est:$${estCost.toFixed(6)}`);

    let parsed;
    try { parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }

    const out = {
      src: String(parsed?.src ?? text),
      tgt: String(parsed?.tgt ?? '')
    };

    return res.json({ ...out, usage: { inTok, outTok }, estimated_cost: estCost });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: 'Server error in /translate' });
  }
});

// ---------------- NEW: /chat (translate + bot reply) ----------------
// Body: { text, mode }
// Returns:
// {
//   user: { src, tgt, src_lang, tgt_lang },
//   bot:  { src, tgt, src_lang, tgt_lang }
// }
app.post('/chat', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY in .env' });

    const { text, mode } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Missing text' });

    const styleLine = (mode === 'literal')
      ? 'Translate as literally as possible while still grammatical.'
      : 'Translate naturally and idiomatically with concise, conversational phrasing.';

    // JSON schema so the client gets a guaranteed structure
    const jsonSchema = {
      name: "bilingual_turn",
      schema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              src: { type: "string" },
              tgt: { type: "string" },
              src_lang: { type: "string", enum: ["en", "es"] },
              tgt_lang: { type: "string", enum: ["en", "es"] }
            },
            required: ["src", "tgt", "src_lang", "tgt_lang"],
            additionalProperties: false
          },
          bot: {
            type: "object",
            properties: {
              src: { type: "string" },
              tgt: { type: "string" },
              src_lang: { type: "string", enum: ["en", "es"] },
              tgt_lang: { type: "string", enum: ["en", "es"] }
            },
            required: ["src", "tgt", "src_lang", "tgt_lang"],
            additionalProperties: false
          }
        },
        required: ["user", "bot"],
        additionalProperties: false
      },
      strict: true
    };

    const sys = `
You are a bilingual assistant for English and Spanish.

Task:
1) Detect the user's source language ("en" or "es") from their message.
2) Produce the user's translation into the other language.
3) Write a concise, friendly chatbot reply in the OTHER language (the user's target language).
4) Also provide that chatbot reply translated back into the user's original language.

Return JSON ONLY matching the provided schema.
Guidelines:
- ${styleLine}
- Keep meanings accurate and natural.
- Be helpful and brief in the bot reply (1–2 sentences).
`.trim();

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_TEXT,
        response_format: { type: "json_schema", json_schema: jsonSchema },
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: text }
        ]
      })
    });

    if (!r.ok) {
      const detailText = await r.text();
      console.error('OpenAI /chat (bot) error:', r.status, detailText);
      return res.status(500).json({ error: 'OpenAI error', detail: detailText });
    }

    const json = await r.json();
    const usage = json?.usage || {};
    const inTok  = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const estCost = inTok * INPUT_RATE_USD + outTok * OUTPUT_RATE_USD;
    console.log(`/chat usage -> in:${inTok} out:${outTok} est:$${estCost.toFixed(6)}`);

    let parsed;
    try { parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}'); } catch { parsed = null; }

    if (!parsed?.user || !parsed?.bot) {
      // Fail-safe minimal shape
      const looksSpanish = /[áéíóúñ¿¡]|\bespañol\b|\bgracias\b|\bhola\b|\busted\b|\bseñor\b/i.test(text);
      const user = {
        src: text,
        tgt: text,
        src_lang: looksSpanish ? 'es' : 'en',
        tgt_lang: looksSpanish ? 'en' : 'es'
      };
      const bot = {
        src: looksSpanish ? '¿En qué más puedo ayudarte?' : 'How else can I help?',
        tgt: looksSpanish ? 'How else can I help?' : '¿En qué más puedo ayudarte?',
        src_lang: looksSpanish ? 'es' : 'en',
        tgt_lang: looksSpanish ? 'en' : 'es'
      };
      return res.json({ user, bot, usage: { inTok, outTok }, estimated_cost: estCost });
    }

    return res.json({ ...parsed, usage: { inTok, outTok }, estimated_cost: estCost });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error in /chat' });
  }
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
