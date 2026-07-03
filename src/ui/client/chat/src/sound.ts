// Audio feedback for agent activity.
//
// Tones are synthesized with the WebAudio API — no asset files. Browser
// autoplay policy keeps the AudioContext suspended until a user gesture,
// so we attach one-time unlock listeners and also resume lazily on play.
import { effect } from '@preact/signals';
import { progressSoundMutedSig, PROGRESS_SOUND_KEY, completionSoundMutedSig, COMPLETION_SOUND_KEY } from './state';

let ctx: AudioContext | null = null;
let unlocked = false;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const AC =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  } catch {
    return null;
  }
  return ctx;
}

function unlock(): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});
  unlocked = true;
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export function initSound(): void {
  progressSoundMutedSig.value = loadBool(PROGRESS_SOUND_KEY, false);
  completionSoundMutedSig.value = loadBool(COMPLETION_SOUND_KEY, false);
  effect(() => {
    try {
      localStorage.setItem(PROGRESS_SOUND_KEY, progressSoundMutedSig.value ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  effect(() => {
    try {
      localStorage.setItem(COMPLETION_SOUND_KEY, completionSoundMutedSig.value ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  const opts = { once: true, passive: true } as const;
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(ev, unlock, opts);
  }
}

// Synthesize a short tone. Peak gain is kept low so feedback stays subtle.
function tone(freq: number, durMs: number, peak = 0.05, type: OscillatorType = 'sine'): void {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});
  if (!unlocked && c.state !== 'running') return;
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + durMs / 1000 + 0.02);
}

let lastTick = 0;
const TICK_MIN_INTERVAL_MS = 2000;

// Subtle tick on meaningful progress (new tool call / phase). Rate-limited
// so a burst of steps in one frame doesn't machine-gun the speaker.
export function playProgressTick(): void {
  if (progressSoundMutedSig.value) return;
  const now = Date.now();
  if (now - lastTick < TICK_MIN_INTERVAL_MS) return;
  lastTick = now;
  tone(660, 70, 0.04);
}

// Distinct two-note chime when the agent's final response arrives.
export function playCompletionChime(): void {
  if (completionSoundMutedSig.value) return;
  tone(660, 120, 0.05);
  setTimeout(() => tone(880, 180, 0.05), 110);
}
