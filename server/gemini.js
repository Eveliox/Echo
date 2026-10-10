// Gemini for the Responder: REST generateContent with the built-in fetch, no
// SDK. The key is sent in the x-goog-api-key header, never in the URL, and
// errors are fixed text plus a status code: never the key or Gemini's answer.

import { MODEL_TIMEOUT_MS } from './responder.js';

// gemini-2.5-flash is closed to new accounts (Google answers 404), so default to 3.8 Flash. GEMINI_MODEL overrides it.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// From server/.env (loaded by loadEnv). Blank values count as unset.
export function readGeminiConfig(env = process.env) {
  return {
    apiKey: (env.GEMINI_API_KEY || '').trim(),
    model: (env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL,
  };
}

// What the server prints at startup about the Responder. Never the key.
export function responderStartupMessage({ apiKey, model }) {
  if (!apiKey) return 'responder: off (no GEMINI_API_KEY)';
  return `responder: on (Gemini ${model}; it can only add calls and messages, the backup ladder keeps its schedule)`;
}

// Returns model({ system, prompt, tools, signal }) for createResponder: one
// generateContent request that must answer with a function call. Resolves to
// { name, args }, or null if Gemini answered without one; throws on failure.
export function geminiModel({ apiKey, model }, { fetchFn = fetch } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return async function ask({ system, prompt, tools, signal }) {
    const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      // Low thinking keeps replies near 3-5 s, well inside MODEL_TIMEOUT_MS (measured on 3.8 Flash).
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    };
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new Error('the Gemini request failed or timed out');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Gemini answered ${res.status}`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('the Gemini answer was not readable JSON');
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    const found = Array.isArray(parts) ? parts.find((p) => p?.functionCall)?.functionCall : null;
    return found ? { name: found.name, args: found.args ?? {} } : null;
  };
}
