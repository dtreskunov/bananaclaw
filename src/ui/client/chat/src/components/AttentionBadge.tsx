import './AttentionBadge.css';

export function AttentionBadge({
  value,
  label,
}: {
  value: number | string;
  label: string;
}) {
  return (
    <span class="attention-badge" aria-label={label}>
      {value}
    </span>
  );
}
