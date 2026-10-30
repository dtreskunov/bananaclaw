import './ActionIcons.css';

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

export function TrashIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" />
      <path d="M4 4.5l.7 8.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.1" />
      <path d="M6.75 7v4M9.25 7v4" />
    </svg>
  );
}

export function RefreshIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12.5 5A5 5 0 1 0 13 9M12.5 2v3.5H9" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8 3.5 3.5L13 4.5" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg class="msg-action-icon msg-action-icon-solid" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m5 3 8 5-8 5z" />
    </svg>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg class="msg-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9 2.5h4.5V7M13 3 7 9M7 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" />
    </svg>
  );
}
