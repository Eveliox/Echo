// ElevenLabs Agents Platform: config from .env and the outbound-call request.
// Every assumption about ElevenLabs' API shape lives in this file. Reached
// with the built-in fetch, no SDK. Checked against elevenlabs.io/docs
// (api-reference/twilio/outbound-call, api-reference/authentication).
// Errors are fixed text plus a status code: never the key, the number, or
// ElevenLabs' answer (which can quote the number).

export const ELEVENLABS_OUTBOUND_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
// ElevenLabs must accept the call within this, or the Twilio spoken call is placed instead.
export const ELEVENLABS_TIMEOUT_MS = 8_000;

const setting = (v) => (v || '').trim();

// From server/.env (loaded by loadEnv). Blank values count as unset.
export function readElevenLabsConfig(env = process.env) {
  return {
    apiKey: setting(env.ELEVENLABS_API_KEY),
    agentId: setting(env.ELEVENLABS_AGENT_ID),
    phoneNumberId: setting(env.ELEVENLABS_PHONE_NUMBER_ID),
  };
}

// Names (never values) of the .env keys a voice call needs that are unset.
export function missingElevenLabsSettings(config) {
  const required = {
    ELEVENLABS_API_KEY: config?.apiKey,
    ELEVENLABS_AGENT_ID: config?.agentId,
    ELEVENLABS_PHONE_NUMBER_ID: config?.phoneNumberId,
  };
  return Object.keys(required).filter((name) => !required[name]);
}

// Returns start({ to, firstMessage, variables, signal }) that asks ElevenLabs
// to place one outbound call through the Twilio number imported there. The
// agent opens with `firstMessage` (needs the agent's "First message" override
// enabled) and gets `variables` as dynamic variables. Resolves to
// { conversationId, callSid }; throws if the call was not accepted.
export function elevenLabsDialer({ apiKey, agentId, phoneNumberId }, { fetchFn = fetch } = {}) {
  return async function start({ to, firstMessage, variables, signal }) {
    const timeout = AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS);
    const body = {
      agent_id: agentId,
      agent_phone_number_id: phoneNumberId,
      to_number: to,
      conversation_initiation_client_data: {
        dynamic_variables: variables,
        conversation_config_override: { agent: { first_message: firstMessage } },
      },
    };
    let res;
    try {
      res = await fetchFn(ELEVENLABS_OUTBOUND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new Error('the ElevenLabs request failed or timed out');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`ElevenLabs answered ${res.status}`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('the ElevenLabs answer was not readable JSON');
    }
    if (data?.success !== true) throw new Error('ElevenLabs did not accept the call');
    return { conversationId: data.conversation_id ?? null, callSid: data.callSid ?? null };
  };
}
