import { useEffect, useRef, useState } from 'preact/hooks';
import { thinkingLevelLabel } from '../../../../shared/thinking-levels';
import './ThinkingDial.css';

export function ThinkingDial({
  levels,
  defaultLevel,
  value,
  disabled,
  onChange,
}: {
  levels: readonly string[];
  defaultLevel: string | null;
  value?: string;
  disabled: boolean;
  onChange: (level: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = value
    ? `${thinkingLevelLabel(value)}${levels.includes(value) ? '' : ' (unsupported)'} · next message`
    : `Agent default${defaultLevel ? ` (${thinkingLevelLabel(defaultLevel)})` : ''}`;
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open || disabled) return;
    (
      root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
    )?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, disabled]);
  return (
    <div
      class="thinking-dial"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
        const current = items.findIndex((item) => item === document.activeElement);
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }}
    >
      <button
        type="button"
        ref={trigger}
        class={`thinking-dial-trigger${value ? ' overridden' : ''}`}
        title={`Thinking: ${label}`}
        aria-label={`Thinking: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 12V9a6 6 0 0 1 12 0v3M3.5 9H2m12 0h-1.5M8 3v1.5M4 5l1 1m7-1-1 1M8 10l3-3" />
          <circle cx="8" cy="10" r="1" />
        </svg>
      </button>
      {open && !disabled ? (
        <div class="thinking-dial-menu flush-menu-panel" role="menu" aria-label="Thinking for next message">
          {[undefined, ...levels].map((level) => (
            <button
              type="button"
              key={level ?? 'default'}
              role="menuitemradio"
              aria-checked={value === level}
              onClick={() => {
                onChange(level);
                close();
              }}
            >
              {level ? thinkingLevelLabel(level) : 'Agent default'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
