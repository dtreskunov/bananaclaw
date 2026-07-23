import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { apiPath, call, errMsg } from './GroupAdminApi';
import { showToast } from './Toast';

interface MemberDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  isExplicitMember: boolean;
  isAdmin: boolean;
}

interface RoleDto {
  userId: string;
  displayName: string | null;
  primaryHandle: string | null;
  primaryChannel: string | null;
  grantedAt: string;
  grantedBy: string | null;
}

interface UserSearchDto {
  userId: string;
  displayName: string | null;
  kind: string;
  primaryHandle: string | null;
  primaryChannel: string | null;
}

// ── Members ───────────────────────────────────────────────────────────────

export function MembersTab({ gid }: { gid: string }): JSX.Element {
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const r = await call<{ members: MemberDto[] }>(apiPath(gid, '/members'));
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
    setMembers(r.data.members);
  }
  useEffect(() => { refresh(); }, [gid]);

  async function add(userId: string): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, '/members'), 'POST', { userId });
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Member added');
      refresh();
    } finally { setBusy(false); }
  }

  async function remove(m: MemberDto): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, `/members/${encodeURIComponent(m.userId)}`), 'DELETE');
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Member removed');
      refresh();
    } finally { setBusy(false); }
  }

  if (!members) return <p class="muted">Loading…</p>;

  return (
    <section>
      <p class="muted">
        Members can interact with this group when channel routing requires "known" senders. Admins of the group are implicit members (shown below for context).
      </p>
      {members.length === 0
        ? <p class="muted">No members yet.</p>
        : (
          <table class="settings-table">
            <thead><tr><th>Name</th><th>Identity</th><th></th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    {m.displayName || <span class="muted">(no name)</span>}
                    {m.isAdmin ? <span class="group-admin-badge" title="Admin of this group">admin</span> : null}
                  </td>
                  <td>{m.primaryHandle ? <code>{m.primaryChannel}:{m.primaryHandle}</code> : <code class="muted">{m.userId}</code>}</td>
                  <td>
                    {m.isExplicitMember && !m.isAdmin
                      ? <button type="button" class="danger" disabled={busy} onClick={() => remove(m)}>Remove</button>
                      : <span class="muted">{m.isAdmin ? 'implicit' : ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h4>Add a member</h4>
      <UserPicker
        gid={gid}
        excludeUserIds={new Set(members.map((m) => m.userId))}
        disabled={busy}
        onPick={add}
      />
    </section>
  );
}

// ── Roles (scoped admin grants on this group) ─────────────────────────────

export function RolesTab({ gid }: { gid: string }): JSX.Element {
  const [admins, setAdmins] = useState<RoleDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    const r = await call<{ admins: RoleDto[] }>(apiPath(gid, '/roles'));
    if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
    setAdmins(r.data.admins);
  }
  useEffect(() => { refresh(); }, [gid]);

  async function grant(userId: string): Promise<void> {
    setBusy(true);
    try {
      const r = await call<{ ok?: boolean; alreadyGranted?: boolean }>(
        apiPath(gid, '/roles'), 'POST', { userId },
      );
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast(r.data.alreadyGranted ? 'Already an admin' : 'Admin granted');
      refresh();
    } finally { setBusy(false); }
  }

  async function revoke(a: RoleDto): Promise<void> {
    setBusy(true);
    try {
      const r = await call(apiPath(gid, `/roles/${encodeURIComponent(a.userId)}`), 'DELETE');
      if (!r.ok) { showToast(errMsg(r.data, `HTTP ${r.status}`), 'err'); return; }
      showToast('Admin revoked');
      refresh();
    } finally { setBusy(false); }
  }

  if (!admins) return <p class="muted">Loading…</p>;

  return (
    <section>
      <p class="muted">
        Admins of this group can change its settings, manage members, and grant/revoke admin on this group only. Global owner and global admins are not shown here — they manage all groups system-wide.
      </p>
      {admins.length === 0
        ? <p class="muted">No scoped admins. (Global admins still have full access.)</p>
        : (
          <table class="settings-table">
            <thead><tr><th>Name</th><th>Identity</th><th></th></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.userId}>
                  <td>{a.displayName || <span class="muted">(no name)</span>}</td>
                  <td>{a.primaryHandle ? <code>{a.primaryChannel}:{a.primaryHandle}</code> : <code class="muted">{a.userId}</code>}</td>
                  <td><button type="button" class="danger" disabled={busy} onClick={() => revoke(a)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h4>Grant admin</h4>
      <UserPicker
        gid={gid}
        excludeUserIds={new Set(admins.map((a) => a.userId))}
        disabled={busy}
        onPick={grant}
      />
    </section>
  );
}

// ── shared user picker ────────────────────────────────────────────────────

function UserPicker({
  gid,
  excludeUserIds,
  disabled,
  onPick,
}: {
  gid: string;
  excludeUserIds: Set<string>;
  disabled?: boolean;
  onPick: (userId: string) => Promise<void>;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserSearchDto[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await call<{ users: UserSearchDto[] }>(
          apiPath(gid, `/users-search?q=${encodeURIComponent(q)}`),
        );
        if (!cancelled && r.ok) setResults(r.data.users);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, gid]);

  const visible = results.filter((u) => !excludeUserIds.has(u.userId)).slice(0, 20);

  return (
    <>
      <div class="settings-row">
        <input
          type="text"
          placeholder="Search name, handle, or user id"
          value={q}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setQ(e.currentTarget.value)}
          disabled={disabled}
        />
      </div>
      {searching && visible.length === 0 ? <p class="muted">Searching…</p> : null}
      {visible.length > 0 ? (
        <ul class="group-admin-search-results">
          {visible.map((u) => (
            <li key={u.userId}>
              <button
                type="button"
                class="group-admin-search-row"
                disabled={disabled}
                onClick={() => onPick(u.userId)}
              >
                <span class="group-admin-search-name">{u.displayName || u.userId}</span>
                <span class="group-admin-search-handle">
                  {u.primaryHandle ? `${u.primaryChannel}:${u.primaryHandle}` : u.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!searching && q && visible.length === 0 ? <p class="muted">No matches.</p> : null}
    </>
  );
}