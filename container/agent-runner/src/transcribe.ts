/**
 * Server-side audio transcription via OpenRouter.
 *
 * When the client's Web Speech API fails, raw audio is sent to the agent.
 * OpenCode doesn't correctly convert `file` parts into the `input_audio`
 * format that Gemini requires, so the model can't hear the audio inline.
 *
 * This module makes a direct API call to OpenRouter with the correct
 * `input_audio` content type to transcribe audio before passing to the agent.
 */
import fs from 'fs';

const DEFAULT_TRANSCRIPTION_MODEL = 'google/gemini-2.0-flash-lite-001';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 15_000;

/** MIME-to-format mapping for the input_audio API */
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

export function isAudioMime(mime: string): boolean {
  return mime.startsWith('audio/');
}

/**
 * Transcribe an audio file by calling OpenRouter directly.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(filePath: string, mime: string, model?: string): Promise<string | null> {
  const format = openRouterAudioFormat(mime);
  if (!format) return null;

  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  if (data.length === 0) return null;

  const b64 = data.toString('base64');

  const body = {
    model: model || DEFAULT_TRANSCRIPTION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: b64, format },
          },
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

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer placeholder',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
