// AI EXPLANATION LAYER — thin client for an LLM API. It only ever receives structured, pre-computed facts.
const config = require('../config');

class AiUnavailableError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason; // 'not_configured' | 'timeout' | 'error'
  }
}

const isConfigured = () => Boolean(config.llm.apiKey);

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) throw new AiUnavailableError(`LLM HTTP ${res.status}`, 'error');
    return await res.json();
  } catch (err) {
    if (err instanceof AiUnavailableError) throw err;
    throw new AiUnavailableError(err.name === 'AbortError' ? 'LLM timed out' : `LLM request failed: ${err.message}`, err.name === 'AbortError' ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the model's text. Throws AiUnavailableError on any problem so callers can fall back. */
async function complete({ system, user, maxTokens = 600 }) {
  if (!isConfigured()) throw new AiUnavailableError('LLM not configured', 'not_configured');
  const { provider, apiKey, model, baseUrl } = config.llm;
  if (provider === 'openai') {
    const data = await postJson(`${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { authorization: `Bearer ${apiKey}` }, {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new AiUnavailableError('Empty LLM response', 'error');
    return text.trim();
  }
  const data = await postJson(`${(baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, {
    model, max_tokens: maxTokens, temperature: 0.2, system,
    messages: [{ role: 'user', content: user }],
  });
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new AiUnavailableError('Empty LLM response', 'error');
  return text;
}

module.exports = { complete, isConfigured, AiUnavailableError };
