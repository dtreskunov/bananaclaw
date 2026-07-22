/**
 * Server-side streaming audio transcription via OpenRouter.
 *
 * Called by the chat route POST `/voice/transcribe`. Accepts audio as a
 * buffer, calls OpenRouter with `stream: true` + `input_audio`, and yields
 * transcript text deltas as they arrive.
 *
 * Requests are routed through the OneCLI proxy which injects the OpenRouter
 * API key automatically. Falls back to a local OPENROUTER_API_KEY env var
 * if the proxy is unavailable.
 */
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import { proxyFetch, isProxyAvailable } from './onecli-proxy.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-lite-001';
const TIMEOUT_MS = 30_000;

const MIME_TO_FORMAT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
};

export function openRouterAudioFormat(mime: string): string | undefined {
  return MIME_TO_FORMAT[mime];
}

function getApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = readEnvFile(['OPENROUTER_API_KEY']);
  return env.OPENROUTER_API_KEY;
}

/**
 * Stream transcription of an audio buffer via OpenRouter.
 * Yields partial transcript text as it arrives from the API.
 *
 * Uses the OneCLI proxy to inject the API key. When `agentIdentifier` is
 * provided, credentials are scoped to that agent's vault assignment; the
 * caller is responsible for ensuring the OneCLI agent exists. Falls back
 * to a local OPENROUTER_API_KEY if the proxy is unavailable.
 */
export async function* streamTranscribe(
  audioBuffer: Buffer,
  mime: string,
  model?: string | null,
  agentIdentifier?: string,
): AsyncGenerator<string> {
  const format = openRouterAudioFormat(mime);
  if (!format) throw new Error(`unsupported_mime: ${mime}`);
  if (audioBuffer.length === 0) throw new Error('empty_audio');

  const useProxy = await isProxyAvailable(agentIdentifier);
  const apiKey = useProxy ? undefined : getApiKey();
  if (!useProxy && !apiKey) throw new Error('missing_api_key');

  const b64 = audioBuffer.toString('base64');
  const envDefault = readEnvFile(['DEFAULT_TRANSCRIPTION_MODEL']).DEFAULT_TRANSCRIPTION_MODEL;
  const body = {
    model: model || envDefault || DEFAULT_MODEL,
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: b64, format } },
          {
            type: 'text',
            text: 'Transcribe this audio exactly as spoken. Output ONLY the transcript, nothing else. If the audio is silent or unintelligible, output "[inaudible]".',
          },
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await proxyFetch(OPENROUTER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: TIMEOUT_MS,
    agent: agentIdentifier,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log.error('OpenRouter transcription failed', { status: res.status, body: errText.slice(0, 200) });
    throw new Error(`openrouter_error_${res.status}`);
  }

  if (!res.body) throw new Error('no_response_body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {
          // skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
