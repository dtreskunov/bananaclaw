/**
 * Pending OAuth sign-ins started from group settings, keyed by the gateway's
 * `state`. The host keeps who started each one so the public callback only
 * completes for that same signed-in user, and so the settings tab can poll
 * for the result. In memory only: a host restart just means signing in again.
 */
export const SIGN_IN_TTL_MS = 10 * 60_000;

export interface SignIn {
  state: string;
  userId: string;
  agentGroupId: string;
  /** What the UI shows, e.g. the MCP server name. */
  label: string;
  mcpServer?: string;
  createdAt: number;
  status: 'pending' | 'connected' | 'failed';
  /** Authoritative completion key; reconnecting may reuse an existing account. */
  key?: string;
  account?: string | null;
  error?: string;
}

const signIns = new Map<string, SignIn>();

function prune(now: number): void {
  for (const [state, s] of signIns) if (now - s.createdAt > SIGN_IN_TTL_MS) signIns.delete(state);
}

export function recordSignIn(entry: Omit<SignIn, 'createdAt' | 'status'>, now = Date.now()): SignIn {
  prune(now);
  const signIn: SignIn = { ...entry, createdAt: now, status: 'pending' };
  signIns.set(entry.state, signIn);
  return signIn;
}

/** The sign-in for `state`, or undefined when unknown or expired. */
export function getSignIn(state: string, now = Date.now()): SignIn | undefined {
  prune(now);
  return signIns.get(state);
}

export function finishSignIn(
  state: string,
  result: { status: 'connected' | 'failed'; key?: string; account?: string | null; error?: string },
): SignIn | undefined {
  const signIn = signIns.get(state);
  if (!signIn) return undefined;
  Object.assign(signIn, result);
  return signIn;
}

/** Test seam. */
export function clearSignIns(): void {
  signIns.clear();
}
