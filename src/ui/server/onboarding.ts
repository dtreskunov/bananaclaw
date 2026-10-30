/**
 * First-login onboarding for OIDC users.
 *
 * Flow:
 *   1. The OIDC callback / pending-approval poll calls `completeLogin`,
 *      which checks `users.onboarded_at`. If NULL, the redirect target
 *      becomes `/ui/onboarding` instead of `/ui/chat/`.
 *   2. GET /ui/onboarding renders a splash + a short form (display name
 *      only if the OIDC claims didn't carry one; agent name; assistant
 *      name with sensible defaults).
 *   3. POST /ui/onboarding applies the answers — display_name on the
 *      user, name on the per-user agent group, assistant_name on its
 *      container_config — then stamps `onboarded_at` and redirects to
 *      the personal Credentials UI for an AgentVault group, or `/ui/chat/`
 *      for an existing legacy group.
 *
 * Already-onboarded users (or anyone hitting the page without a session)
 * are bounced straight to `/ui/chat/` so refresh / back-button on the
 * onboarding URL never traps them.
 */
import http from 'http';

import { log } from '../../log.js';
import { updateAgentGroup } from '../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { usesAgentVault } from '../../modules/credentials/agent-vault-client.js';
import { ensurePerUserAgentGroup } from '../../modules/permissions/user-approval.js';
import { getUser, isUserOnboarded, markUserOnboarded, updateDisplayName } from '../../modules/permissions/db/users.js';

import { authenticate } from './auth.js';
import { getBranding } from './branding.js';
import { renderPageShell, escapeHtml } from './page-shell.js';

const LANDING = '/ui/chat/';
const DEFAULT_GROUP_NAME = 'My Agent';
const DEFAULT_ASSISTANT_NAME = 'Your Agent';
const MAX_NAME_LEN = 80;

interface OnboardingPrefill {
  displayName: string | null;
  groupName: string;
  assistantName: string;
  needsDisplayName: boolean;
}

function renderPage(prefill: OnboardingPrefill, errorMessage: string | null): string {
  const brand = escapeHtml(getBranding().name);
  const displayField = prefill.needsDisplayName
    ? `
      <label class="row">
        <span class="lbl">Your name</span>
        <input type="text" name="displayName" required maxlength="${MAX_NAME_LEN}"
               autocomplete="name" autofocus
               value="${escapeHtml(prefill.displayName ?? '')}"
               placeholder="How should we address you?" />
      </label>
    `
    : '';
  const error = errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : '';
  return renderPageShell({
    title: 'Welcome',
    bodyHtml: `
      <h1>Welcome — let's set up your agent</h1>
      <p class="lead">A few quick choices and you're in.</p>

      <h2>Why ${brand} beats Gemini for daily work</h2>
      <ul class="benefits">
        <li><strong>Yours, end to end.</strong> Runs in your account on your hardware — your data never feeds someone else's model.</li>
        <li><strong>Reaches you anywhere.</strong> Slack, Discord, email, iMessage, web — one agent, every channel you use.</li>
        <li><strong>Remembers and learns.</strong> Persistent memory and per-group instructions, so it gets sharper the more you use it.</li>
        <li><strong>Takes real action.</strong> Runs code, edits files, calls APIs, schedules tasks — not just chat replies.</li>
        <li><strong>Any model, any time.</strong> Switch between Claude, GPT, Gemini, or local models per group.</li>
      </ul>

      ${error}
      <form method="POST" action="/ui/onboarding" autocomplete="on" novalidate>
        ${displayField}
        <label class="row">
          <span class="lbl">What do you want to call your agent?</span>
          <input type="text" name="groupName" required maxlength="${MAX_NAME_LEN}"
                 value="${escapeHtml(prefill.groupName)}" />
          <span class="hint">Shows up in your sidebar — e.g. "${escapeHtml(DEFAULT_GROUP_NAME)}".</span>
        </label>
        <label class="row">
          <span class="lbl">What should the agent call itself?</span>
          <input type="text" name="assistantName" required maxlength="${MAX_NAME_LEN}"
                 value="${escapeHtml(prefill.assistantName)}" />
          <span class="hint">How the agent introduces itself — e.g. "${escapeHtml(DEFAULT_ASSISTANT_NAME)}".</span>
        </label>
        <button class="btn" type="submit">Get started</button>
      </form>
    `,
  });
}

/**
 * Locate (or lazy-create) the per-user agent group provisioned by
 * `approvePendingUser`. We delegate to `ensurePerUserAgentGroup` so that
 * users whose group was never created (predate auto-provisioning) or was
 * archived get one minted on the spot — otherwise the onboarding wizard
 * would silently complete and the user would land in chat with zero
 * accessible groups.
 */
function findPerUserAgentGroupId(userId: string): string | null {
  return ensurePerUserAgentGroup(userId);
}

async function readUrlEncodedBody(req: http.IncomingMessage, max = 16 * 1024): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function trimToMax(s: string): string {
  return s.trim().slice(0, MAX_NAME_LEN);
}

function renderHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export async function handleOnboarding(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const session = authenticate(req);
  if (!session) {
    redirect(res, '/ui/login?next=' + encodeURIComponent('/ui/onboarding'));
    return;
  }

  if (isUserOnboarded(session.userId)) {
    redirect(res, LANDING);
    return;
  }

  const user = getUser(session.userId);
  const hasName = !!user?.display_name?.trim();
  const prefill: OnboardingPrefill = {
    displayName: user?.display_name ?? null,
    groupName: DEFAULT_GROUP_NAME,
    assistantName: DEFAULT_ASSISTANT_NAME,
    needsDisplayName: !hasName,
  };

  if (req.method === 'GET') {
    renderHtml(res, 200, renderPage(prefill, null));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readUrlEncodedBody(req);
  } catch {
    renderHtml(res, 400, renderPage(prefill, 'Form submission was too large. Try again.'));
    return;
  }

  const submittedName = trimToMax(form.get('displayName') ?? prefill.displayName ?? '');
  const groupName = trimToMax(form.get('groupName') ?? '') || DEFAULT_GROUP_NAME;
  const assistantName = trimToMax(form.get('assistantName') ?? '') || DEFAULT_ASSISTANT_NAME;

  if (prefill.needsDisplayName && !submittedName) {
    prefill.groupName = groupName;
    prefill.assistantName = assistantName;
    renderHtml(res, 400, renderPage(prefill, 'Please tell us your name.'));
    return;
  }

  if (submittedName && submittedName !== user?.display_name) {
    updateDisplayName(session.userId, submittedName);
  }

  const agentGroupId = findPerUserAgentGroupId(session.userId);
  if (agentGroupId) {
    try {
      updateAgentGroup(agentGroupId, { name: groupName });
      updateContainerConfigScalars(agentGroupId, { assistant_name: assistantName });
    } catch (err) {
      log.warn('onboarding: failed to apply group/assistant names', { userId: session.userId, agentGroupId, err });
    }
  } else {
    log.info('onboarding: user has no per-user agent group to rename', { userId: session.userId });
  }

  markUserOnboarded(session.userId);
  log.info('onboarding completed', {
    userId: session.userId,
    renamedGroup: agentGroupId,
    setDisplayName: !!submittedName && submittedName !== user?.display_name,
  });

  redirect(res, agentGroupId && usesAgentVault(agentGroupId) ? `${LANDING}#credentials` : LANDING);
}

// Stand-alone path matcher: server.ts mounts at /ui/onboarding and delegates.
export const ONBOARDING_PATH = '/ui/onboarding';

/** Test-only: exposed defaults so the test suite can assert UI copy. */
export const _DEFAULTS = {
  groupName: DEFAULT_GROUP_NAME,
  assistantName: DEFAULT_ASSISTANT_NAME,
};

/** Used by `completeLogin` to choose between LANDING and ONBOARDING_PATH. */
export function postLoginRedirect(userId: string, requestedNext: string): string {
  if (!isUserOnboarded(userId)) return ONBOARDING_PATH;
  return requestedNext;
}
