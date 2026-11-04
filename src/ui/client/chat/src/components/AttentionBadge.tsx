import './AttentionBadge.css';

export function AttentionBadge({
  value,
  neutral = false,
  label,
}: {
  value: number | string;
  neutral?: boolean;
  label: string;
}) {
  return (
    <span class={`attention-badge${neutral ? ' attention-badge-neutral' : ''}`} aria-label={label}>
      {value}
    </span>
  );
}
