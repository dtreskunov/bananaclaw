import './GroupAdminSkills.css';
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { GroupAdminField as Field } from './GroupAdminField';

const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function SkillsSection({
  value,
  busy,
  onChange,
}: {
  value: string[] | 'all';
  busy: boolean;
  onChange: (next: string[] | 'all') => void;
}): JSX.Element {
  const isAll = value === 'all';
  const list = isAll ? [] : value;
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const isInvalid = trimmed !== '' && !SKILL_SLUG_RE.test(trimmed);
  const isDup = trimmed !== '' && list.includes(trimmed);
  const canAdd = !isAll && trimmed !== '' && !isInvalid && !isDup;

  function add(): void {
    if (!canAdd) return;
    onChange([...list, trimmed]);
    setDraft('');
  }

  function remove(index: number): void {
    onChange(list.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Container skills mounted into every session in this group. Restart required to take
          effect — skill mounts are computed at container spawn. Use "all" to mount every
          available container skill, or pick specific slugs from <code>container/skills/</code>.
        </p>
      </div>

      <Field label="Selection">
        <div class="group-admin-stack">
          <label class="group-admin-check">
            <input
              type="radio"
              name="skills-mode"
              checked={isAll}
              disabled={busy}
              onChange={() => onChange('all')}
            />
            <span>All available skills</span>
          </label>
          <label class="group-admin-check">
            <input
              type="radio"
              name="skills-mode"
              checked={!isAll}
              disabled={busy}
              onChange={() => onChange([])}
            />
            <span>Specific skills only</span>
          </label>
        </div>
      </Field>

      {!isAll ? (
        <Field label="Skills" info="Slug per skill (lowercase a–z, 0–9, hyphen). Must match a folder under container/skills/ or a group-local skill.">
          <div class="group-admin-stack ga-skills-list">
            {list.length === 0 ? (
              <p class="group-admin-help">No skills selected.</p>
            ) : (
              <ul class="ga-skills-chips">
                {list.map((skill, index) => (
                  <li key={`${skill}-${index}`} class="ga-skills-chip">
                    <span class="ga-skills-chip-label">{skill}</span>
                    <button
                      type="button"
                      class="ga-skills-chip-remove"
                      aria-label={`Remove ${skill}`}
                      disabled={busy}
                      onClick={() => remove(index)}
                    >
                      {'\u2715'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div class="ga-skills-actions">
              <input
                type="text"
                class="ga-skills-input"
                placeholder="skill slug (e.g. welcome, agent-browser)"
                value={draft}
                disabled={busy}
                onInput={(event: JSX.TargetedEvent<HTMLInputElement>) => setDraft(event.currentTarget.value)}
                onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Enter') { event.preventDefault(); add(); }
                }}
              />
              <button type="button" disabled={busy || !canAdd} onClick={add}>
                + Add
              </button>
            </div>
            {isInvalid ? (
              <p class="ga-confirm-warn">"{trimmed}" must be lowercase a–z, 0–9, hyphen.</p>
            ) : isDup ? (
              <p class="ga-confirm-warn">"{trimmed}" is already in the list.</p>
            ) : null}
          </div>
        </Field>
      ) : null}
    </>
  );
}