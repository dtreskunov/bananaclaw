export function startReconnectCountdown(
  delayMs: number,
  onTick: (secondsRemaining: number) => void,
  onElapsed: () => void,
): () => void {
  const deadline = Date.now() + delayMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const tick = (): void => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      cancelled = true;
      onElapsed();
      return;
    }
    onTick(Math.ceil(remaining / 1000));
    timer = setTimeout(tick, Math.min(1000, remaining));
  };

  tick();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

export function runReconnectImmediately(cancelCountdown: (() => void) | null, reconnect: () => void): boolean {
  if (!cancelCountdown) return false;
  cancelCountdown();
  reconnect();
  return true;
}
