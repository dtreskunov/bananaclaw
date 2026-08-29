// Audit-gated install control. Clicking Install checks skills.sh for
// third-party security audits first; a clean or unaudited skill installs
// straight through, a flagged one opens the panel and demands an explicit
// "Install anyway". The server enforces the same rule, so this is UX, not
// the security boundary.
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import { showToast } from './Toast';

export interface AuditDto {
  provider: string;
  slug: string;
  status: string;
  summary: string;
  auditedAt: string | null;
  riskLevel: string | null;
  categories: string[];
}

const SKILLS_API = '/ui/chat/api/skills';

export function AuditPanel({ audits }: { audits: AuditDto[] | null }): JSX.Element {
  if (audits === null) {
    return (
      <p class="ga-audit-unknown">
        No security audits available for this skill. Unknown is not the same as safe — a skill is
        instructions your agent will follow.
      </p>
    );
  }
  if (audits.length === 0) return <p class="ga-audit-unknown">No audit partner has reviewed this skill yet.</p>;

  return (
    <ul class="ga-audit-list">
      {audits.map((audit) => (
        <li key={audit.provider} class="ga-audit-entry">
          <span class="ga-audit-head">
            <span class={`ga-audit-status ga-audit-${audit.status}`}>{audit.status}</span>
            <strong>{audit.provider}</strong>
            {audit.riskLevel ? <span class="ga-skills-badge">{audit.riskLevel}</span> : null}
          </span>
          {audit.summary ? <span class="ga-audit-summary">{audit.summary}</span> : null}
          {audit.categories.length > 0 ? (
            <span class="ga-audit-categories">{audit.categories.join(' · ')}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function InstallControl({
  source,
  slug,
  installed,
  disabled,
  label = 'Install',
  onInstall,
}: {
  /** GitHub `owner/repo` used for the audit lookup; null skips the check. */
  source: string | null;
  slug: string;
  installed: boolean;
  disabled: boolean;
  label?: string;
  onInstall: (acknowledgeRisk: boolean) => Promise<{ ok: boolean; audits?: AuditDto[] | null }>;
}): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'review'>('idle');
  const [audits, setAudits] = useState<AuditDto[] | null>(null);
  const [showAudits, setShowAudits] = useState(false);

  async function loadAudits(): Promise<{ audits: AuditDto[] | null; blocking: boolean }> {
    if (!source) return { audits: null, blocking: false };
    const r = await call<{ audits: AuditDto[] | null; blocking: boolean }>(
      `${SKILLS_API}/audits?source=${encodeURIComponent(source)}&slug=${encodeURIComponent(slug)}`,
    );
    if (!r.ok) return { audits: null, blocking: false };
    return { audits: r.data.audits, blocking: r.data.blocking };
  }

  async function run(acknowledgeRisk: boolean): Promise<void> {
    setPhase('busy');
    try {
      if (!acknowledgeRisk) {
        const checked = await loadAudits();
        setAudits(checked.audits);
        if (checked.blocking) {
          setShowAudits(true);
          setPhase('review');
          return;
        }
      }
      const result = await onInstall(acknowledgeRisk);
      if (!result.ok && result.audits !== undefined) {
        // Server-side gate fired (stale cache, or the UI check was skipped).
        setAudits(result.audits ?? null);
        setShowAudits(true);
        setPhase('review');
        return;
      }
      setPhase('idle');
    } catch {
      setPhase('idle');
    }
  }

  return (
    <span class="ga-install-control">
      <span class="ga-install-buttons">
        {source ? (
          <button
            type="button"
            class="ga-audit-toggle"
            disabled={phase === 'busy'}
            onClick={async () => {
              if (!showAudits && audits === null) setAudits((await loadAudits()).audits);
              setShowAudits((v) => !v);
            }}
          >
            {showAudits ? 'Hide audits' : 'Audits'}
          </button>
        ) : null}
        {phase === 'review' ? (
          <>
            <button type="button" class="ga-catalog-remove" onClick={() => setPhase('idle')}>
              Cancel
            </button>
            <button type="button" class="ga-install-anyway" onClick={() => run(true)}>
              Install anyway
            </button>
          </>
        ) : (
          <button
            type="button"
            class="ga-catalog-install"
            disabled={disabled || installed || phase === 'busy'}
            onClick={() => run(false)}
          >
            {installed ? 'Installed' : phase === 'busy' ? 'Checking…' : label}
          </button>
        )}
      </span>
      {showAudits || phase === 'review' ? (
        <span class="ga-audit-wrap">
          {phase === 'review' ? (
            <p class="ga-audit-blocked">A security partner flagged this skill. Review before installing.</p>
          ) : null}
          <AuditPanel audits={audits} />
        </span>
      ) : null}
    </span>
  );
}

/** Shared error toast for the skill mutation endpoints. */
export function reportSkillError(data: unknown, status: number): void {
  showToast(errMsg(data, `HTTP ${status}`), 'err');
}
