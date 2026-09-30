/** 16px line icons shared by the bubble action buttons, drawn with currentColor. */

export function CopyIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5l3 3-8 8h-3v-3z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

export function BranchIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="11.5" cy="3.5" r="1.5" />
      <circle cx="8" cy="12.5" r="1.5" />
      <path d="M4.5 5v1a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5" />
      <path d="M8 8v3" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg class="msg-action-icon msg-action-icon-solid" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}
