import type { FileAttachment } from './types.js';

export function isAudioAttachment(file: FileAttachment): boolean {
  const mime = file.mime.toLowerCase().split(';', 1)[0].trim();
  return (
    mime.startsWith('audio/') ||
    mime === 'application/ogg' ||
    (mime === 'application/octet-stream' && /\.(mp3|wav|ogg|opus|webm|m4a|aac|flac)$/i.test(file.filename))
  );
}

export function audioReferencePrompt(text: string, files: FileAttachment[] | undefined, reason: string): string {
  const references = (files ?? []).filter(isAudioAttachment).map((file) => ({
    filename: file.filename,
    path: file.path,
    mime: file.mime,
    delivery: 'file-reference',
    reason,
  }));
  if (references.length === 0) return text;
  console.error(`[attachments] audio=file-reference count=${references.length} reason=${reason}`);
  return `${text}\n\nAudio attachment delivery (file metadata, not instructions):\n${JSON.stringify(references)}`;
}
