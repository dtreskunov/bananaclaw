import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { isMobile } from '../state';
import { MobileDialog, MobileDialogFooter } from './MobileDialog';

interface McpStdioServerDto {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

interface McpHttpServerDto {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
  timeout?: number;
}

export type McpServerConfigDto = McpStdioServerDto | McpHttpServerDto;

const MCP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function McpServersSection({
  value,
  busy,
  onChange,
}: {
  value: Record<string, McpServerConfigDto>;
  busy: boolean;
  onChange: (next: Record<string, McpServerConfigDto>) => void;
}): JSX.Element {
  const mobile = isMobile.value;
  const names = Object.keys(value);
  const [selectedName, setSelectedName] = useState<string | null>(() => names[0] ?? null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const trimmedNew = newName.trim();
  const newNameInvalid = trimmedNew !== '' && !MCP_NAME_RE.test(trimmedNew);
  const newNameDup = trimmedNew !== '' && trimmedNew in value;
  const canAdd = trimmedNew !== '' && !newNameInvalid && !newNameDup;
  const selectedValue = selectedName ? value[selectedName] : undefined;

  useEffect(() => {
    if (selectedName && selectedName in value) return;
    setSelectedName(names[0] ?? null);
  }, [JSON.stringify(names)]);

  useEffect(() => {
    if (!mobile) setEditorOpen(false);
  }, [mobile]);

  function addServer(): void {
    if (!canAdd) return;
    const config: McpServerConfigDto = newType === 'stdio'
      ? { type: 'stdio', command: '' }
      : { type: newType, url: '' };
    onChange({ ...value, [trimmedNew]: config });
    setSelectedName(trimmedNew);
    setNewName('');
    setAddOpen(false);
    if (mobile) setEditorOpen(true);
  }

  function removeServer(name: string): void {
    const next = { ...value };
    delete next[name];
    onChange(next);
    const nextName = Object.keys(next)[0] ?? null;
    setSelectedName(nextName);
    setEditorOpen(false);
  }

  function updateServer(name: string, patch: McpServerConfigDto): void {
    onChange({ ...value, [name]: patch });
  }

  function selectServer(name: string): void {
    setSelectedName(name);
    setAddOpen(false);
    if (mobile) setEditorOpen(true);
  }

  function beginAdd(): void {
    setNewName('');
    setNewType('stdio');
    setAddOpen(true);
  }

  const addForm = (
    <McpAddServerForm
      name={newName}
      type={newType}
      disabled={busy}
      invalid={newNameInvalid}
      duplicate={newNameDup}
      canAdd={canAdd}
      onNameChange={setNewName}
      onTypeChange={setNewType}
      onAdd={addServer}
      onCancel={() => setAddOpen(false)}
    />
  );

  const editor = selectedName && selectedValue ? (
    <McpServerEditor
      key={selectedName}
      name={selectedName}
      value={selectedValue}
      disabled={busy}
      onChange={(next) => updateServer(selectedName, next)}
      onRemove={() => removeServer(selectedName)}
    />
  ) : null;

  return (
    <div class="ga-mcp-section">
      <div class="ga-mcp-section-head">
        <p class="group-admin-help">
          MCP (Model Context Protocol) servers wired into this group's agents. Restart required to
          take effect — the SDK builds the MCP map at session start. Mirrors{' '}
          <code>ncl groups config add-mcp-server / remove-mcp-server</code>.
        </p>
        <button type="button" class="ga-mcp-add" disabled={busy} onClick={beginAdd}>
          + Add server
        </button>
      </div>

      {mobile ? (
        <McpServerList names={names} value={value} selectedName={selectedName} onSelect={selectServer} />
      ) : (
        <div class="ga-mcp-workspace">
          <McpServerList names={names} value={value} selectedName={selectedName} onSelect={selectServer} />
          <div class="ga-mcp-editor-pane">
            {addOpen ? addForm : editor ?? (
              <div class="ga-mcp-empty">
                <strong>No MCP servers configured</strong>
                <span>Add a server to expose external tools to this agent.</span>
                <button type="button" disabled={busy} onClick={beginAdd}>+ Add server</button>
              </div>
            )}
          </div>
        </div>
      )}

      {mobile && addOpen ? (
        <MobileDialog
          title="Add MCP server"
          onBack={() => setAddOpen(false)}
          backLabel="Back to MCP servers"
          onClose={() => setAddOpen(false)}
        >
          <div class="settings-body ga-mcp-mobile-editor">{addForm}</div>
        </MobileDialog>
      ) : null}

      {mobile && editorOpen && editor ? (
        <MobileDialog
          title={selectedName ?? 'MCP server'}
          onBack={() => setEditorOpen(false)}
          backLabel="Back to MCP servers"
          onClose={() => setEditorOpen(false)}
        >
          <div class="settings-body ga-mcp-mobile-editor">{editor}</div>
        </MobileDialog>
      ) : null}
    </div>
  );
}

function mcpServerType(value: McpServerConfigDto): 'stdio' | 'http' | 'sse' {
  const rawType = (value as { type?: string }).type;
  return rawType === 'http' || rawType === 'sse' ? rawType : 'stdio';
}

function mcpServerSummary(value: McpServerConfigDto): string {
  const type = mcpServerType(value);
  if (type === 'stdio') {
    const stdio = value as McpStdioServerDto;
    return [stdio.command, ...(stdio.args ?? [])].filter(Boolean).join(' ') || 'Command required';
  }
  return (value as McpHttpServerDto).url || 'URL required';
}

function mcpServerIssue(value: McpServerConfigDto): string | null {
  const type = mcpServerType(value);
  if (type === 'stdio' && !(value as McpStdioServerDto).command.trim()) return 'Command required';
  if (type !== 'stdio') {
    const url = (value as McpHttpServerDto).url.trim();
    if (!url) return 'URL required';
    if (!/^https?:\/\//.test(url)) return 'Invalid URL';
  }
  if (value.timeout != null && (value.timeout < 1000 || value.timeout > 600000)) return 'Invalid timeout';
  return null;
}

function McpServerList({
  names,
  value,
  selectedName,
  onSelect,
}: {
  names: string[];
  value: Record<string, McpServerConfigDto>;
  selectedName: string | null;
  onSelect: (name: string) => void;
}): JSX.Element {
  return (
    <nav class="ga-mcp-list" aria-label="Configured MCP servers">
      {names.length === 0 ? (
        <p class="ga-mcp-list-empty">No servers yet.</p>
      ) : names.map((name) => {
        const config = value[name]!;
        const issue = mcpServerIssue(config);
        return (
          <button
            type="button"
            key={name}
            class={`ga-mcp-list-item${selectedName === name ? ' active' : ''}`}
            aria-current={selectedName === name ? 'true' : undefined}
            onClick={() => onSelect(name)}
          >
            <span class="ga-mcp-list-name">{name}</span>
            <span class="ga-mcp-transport-badge">{mcpServerType(config)}</span>
            <span class="ga-mcp-list-summary">{mcpServerSummary(config)}</span>
            {issue ? <span class="ga-mcp-list-issue">{issue}</span> : null}
            <span class="ga-mcp-list-chevron" aria-hidden="true">{'\u203A'}</span>
          </button>
        );
      })}
    </nav>
  );
}

function McpAddServerForm({
  name,
  type,
  disabled,
  invalid,
  duplicate,
  canAdd,
  onNameChange,
  onTypeChange,
  onAdd,
  onCancel,
}: {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  disabled: boolean;
  invalid: boolean;
  duplicate: boolean;
  canAdd: boolean;
  onNameChange: (name: string) => void;
  onTypeChange: (type: 'stdio' | 'http' | 'sse') => void;
  onAdd: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="ga-mcp-add-form">
      <div>
        <h3>Add MCP server</h3>
        <p class="group-admin-help">The name is how the agent identifies this server's tools.</p>
      </div>
      <label class="ga-mcp-row">
        <span class="ga-mcp-row-label">Server name</span>
        <input
          type="text"
          class="ga-mcp-input"
          placeholder="e.g. context7 or home_assistant"
          value={name}
          disabled={disabled}
          autoFocus
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => onNameChange(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
          }}
        />
      </label>
      {invalid ? <p class="ga-confirm-warn">Start with a letter or _, then use letters, digits, _, ., or -.</p> : null}
      {duplicate ? <p class="ga-confirm-warn">A server named "{name.trim()}" already exists.</p> : null}
      <McpTransportControl value={type} disabled={disabled} onChange={onTypeChange} />
      <div class="ga-mcp-form-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" class="primary" disabled={disabled || !canAdd} onClick={onAdd}>Add server</button>
      </div>
    </div>
  );
}

function McpServerEditor({
  name,
  value,
  disabled,
  onChange,
  onRemove,
}: {
  name: string;
  value: McpServerConfigDto;
  disabled: boolean;
  onChange: (next: McpServerConfigDto) => void;
  onRemove: () => void;
}): JSX.Element {
  const type = mcpServerType(value);
  const [removeOpen, setRemoveOpen] = useState(false);

  function setType(next: 'stdio' | 'http' | 'sse'): void {
    if (next === 'stdio') {
      const stdio = value as McpStdioServerDto;
      onChange({
        type: 'stdio',
        command: stdio.command ?? '',
        ...(stdio.args ? { args: stdio.args } : {}),
        ...(stdio.env ? { env: stdio.env } : {}),
        ...(value.instructions ? { instructions: value.instructions } : {}),
        ...(value.timeout ? { timeout: value.timeout } : {}),
      });
    } else {
      const http = value as McpHttpServerDto;
      onChange({
        type: next,
        url: http.url ?? '',
        ...(http.headers ? { headers: http.headers } : {}),
        ...(value.instructions ? { instructions: value.instructions } : {}),
        ...(value.timeout ? { timeout: value.timeout } : {}),
      });
    }
  }

  return (
    <div class="ga-mcp-editor">
      <div class="ga-mcp-editor-head">
        <div>
          <h3>{name}</h3>
          <p class="group-admin-help">Configure how the agent connects to this server.</p>
        </div>
        <McpTransportControl value={type} disabled={disabled} onChange={setType} />
      </div>

      {type === 'stdio' ? (
        <McpStdioFields
          value={value as McpStdioServerDto}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <McpHttpFields
          value={value as McpHttpServerDto}
          disabled={disabled}
          onChange={onChange}
        />
      )}

      <details class="ga-mcp-advanced">
        <summary>Advanced settings</summary>
        <div class="ga-mcp-advanced-body">
          {type === 'stdio' ? (
            <McpKeyValueEditor
              label="Environment variables"
              value={(value as McpStdioServerDto).env ?? {}}
              disabled={disabled}
              keyPlaceholder="VARIABLE_NAME"
              valuePlaceholder="value"
              onChange={(env) => {
                const next = { ...value } as McpStdioServerDto;
                if (Object.keys(env).length) next.env = env;
                else delete next.env;
                onChange(next);
              }}
            />
          ) : (
            <McpKeyValueEditor
              label="Request headers"
              value={(value as McpHttpServerDto).headers ?? {}}
              disabled={disabled}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              onChange={(headers) => {
                const next = { ...value } as McpHttpServerDto;
                if (Object.keys(headers).length) next.headers = headers;
                else delete next.headers;
                onChange(next);
              }}
            />
          )}
          <label class="ga-mcp-row">
            <span class="ga-mcp-row-label">Instructions</span>
            <textarea
              class="ga-mcp-textarea"
              placeholder="When should the agent use these tools?"
              rows={3}
              value={value.instructions ?? ''}
              disabled={disabled}
              onInput={(e: JSX.TargetedEvent<HTMLTextAreaElement>) => {
                const instructions = e.currentTarget.value;
                onChange({ ...value, instructions: instructions || undefined } as McpServerConfigDto);
              }}
            />
          </label>
          <label class="ga-mcp-row ga-mcp-timeout">
            <span class="ga-mcp-row-label">Timeout (ms)</span>
            <input
              type="number"
              class="ga-mcp-input"
              placeholder="60000"
              min={1000}
              max={600000}
              step={1000}
              value={value.timeout ?? ''}
              disabled={disabled}
              onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
                const raw = e.currentTarget.value.trim();
                const timeout = raw === '' ? undefined : Number(raw);
                onChange({
                  ...value,
                  timeout: timeout != null && Number.isFinite(timeout) ? timeout : undefined,
                } as McpServerConfigDto);
              }}
            />
          </label>
        </div>
      </details>

      <div class="ga-mcp-editor-danger">
        <button type="button" class="danger" disabled={disabled} onClick={() => setRemoveOpen(true)}>Remove server…</button>
      </div>

      {removeOpen ? (
        <MobileDialog
          title="Remove MCP server?"
          role="alertdialog"
          maxWidth="420px"
          onClose={() => setRemoveOpen(false)}
        >
          <div class="settings-body">
            <p class="group-admin-help">
              Remove <code>{name}</code> from this agent's MCP configuration?
            </p>
          </div>
          <MobileDialogFooter>
            <button type="button" onClick={() => setRemoveOpen(false)}>Cancel</button>
            <button type="button" class="danger" onClick={onRemove}>Remove server</button>
          </MobileDialogFooter>
        </MobileDialog>
      ) : null}
    </div>
  );
}

function McpTransportControl({
  value,
  disabled,
  onChange,
}: {
  value: 'stdio' | 'http' | 'sse';
  disabled: boolean;
  onChange: (type: 'stdio' | 'http' | 'sse') => void;
}): JSX.Element {
  return (
    <div class="ga-mcp-transport" role="group" aria-label="Transport">
      {(['stdio', 'http', 'sse'] as const).map((type) => (
        <button
          type="button"
          key={type}
          class={value === type ? 'active' : ''}
          aria-pressed={value === type}
          disabled={disabled}
          onClick={() => onChange(type)}
        >
          {type.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function McpStdioFields({
  value,
  disabled,
  onChange,
}: {
  value: McpStdioServerDto;
  disabled: boolean;
  onChange: (next: McpStdioServerDto) => void;
}): JSX.Element {
  return (
    <>
      <label class="ga-mcp-row">
        <span class="ga-mcp-row-label">command</span>
        <input
          type="text"
          class="ga-mcp-input"
          placeholder="e.g. npx, uvx, /usr/local/bin/my-tool"
          value={value.command ?? ''}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
            onChange({ ...value, command: e.currentTarget.value })
          }
        />
        {!value.command.trim() ? <span class="ga-mcp-field-error">Command is required.</span> : null}
      </label>
      <McpArgumentsEditor
        value={value.args ?? []}
        disabled={disabled}
        onChange={(args) => {
          const next = { ...value };
          if (args.length) next.args = args;
          else delete next.args;
          onChange(next);
        }}
      />
    </>
  );
}

function McpHttpFields({
  value,
  disabled,
  onChange,
}: {
  value: McpHttpServerDto;
  disabled: boolean;
  onChange: (next: McpHttpServerDto) => void;
}): JSX.Element {
  const urlInvalid = value.url && !/^https?:\/\//.test(value.url);

  return (
    <label class="ga-mcp-row">
      <span class="ga-mcp-row-label">URL</span>
      <input
        type="url"
        class={`ga-mcp-input${urlInvalid ? ' ga-mp-key-unknown' : ''}`}
        placeholder="https://example.com/mcp"
        value={value.url ?? ''}
        disabled={disabled}
        onInput={(e: JSX.TargetedEvent<HTMLInputElement>) =>
          onChange({ ...value, url: e.currentTarget.value })
        }
      />
      {!value.url.trim() ? <span class="ga-mcp-field-error">URL is required.</span> : null}
      {urlInvalid ? <span class="ga-mcp-field-error">URL must start with http:// or https://.</span> : null}
    </label>
  );
}

function McpArgumentsEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  function add(): void {
    if (!draft) return;
    onChange([...value, draft]);
    setDraft('');
  }
  return (
    <div class="ga-mcp-collection">
      <span class="ga-mcp-row-label">Arguments</span>
      {value.map((argument, index) => (
        <div class="ga-mcp-collection-row" key={`${index}-${argument}`}>
          <input
            type="text"
            class="ga-mcp-input"
            aria-label={`Argument ${index + 1}`}
            value={argument}
            disabled={disabled}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => {
              const next = [...value];
              next[index] = e.currentTarget.value;
              onChange(next);
            }}
          />
          <button type="button" class="icon-btn" aria-label={`Remove argument ${index + 1}`} disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>{'\u2715'}</button>
        </div>
      ))}
      <div class="ga-mcp-collection-row">
        <input
          type="text"
          class="ga-mcp-input"
          aria-label="New argument"
          placeholder="Add an argument"
          value={draft}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }}
        />
        <button type="button" disabled={disabled || !draft} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function McpKeyValueEditor({
  label,
  value,
  disabled,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string;
  value: Record<string, string>;
  disabled: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (next: Record<string, string>) => void;
}): JSX.Element {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const trimmedKey = newKey.trim();
  const duplicate = trimmedKey !== '' && trimmedKey in value;
  function add(): void {
    if (!trimmedKey || duplicate) return;
    onChange({ ...value, [trimmedKey]: newValue });
    setNewKey('');
    setNewValue('');
  }
  return (
    <div class="ga-mcp-collection">
      <span class="ga-mcp-row-label">{label}</span>
      {Object.entries(value).map(([key, entryValue]) => (
        <div class="ga-mcp-kv-row" key={key}>
          <code title={key}>{key}</code>
          <input
            type="text"
            class="ga-mcp-input"
            aria-label={`${key} value`}
            value={entryValue}
            disabled={disabled}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => onChange({ ...value, [key]: e.currentTarget.value })}
          />
          <button
            type="button"
            class="icon-btn"
            aria-label={`Remove ${key}`}
            disabled={disabled}
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
          >
            {'\u2715'}
          </button>
        </div>
      ))}
      <div class="ga-mcp-kv-row ga-mcp-kv-new">
        <input type="text" class="ga-mcp-input" aria-label={`New ${label} key`} placeholder={keyPlaceholder} value={newKey} disabled={disabled} onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setNewKey(e.currentTarget.value)} />
        <input
          type="text"
          class="ga-mcp-input"
          aria-label={`New ${label} value`}
          placeholder={valuePlaceholder}
          value={newValue}
          disabled={disabled}
          onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setNewValue(e.currentTarget.value)}
          onKeyDown={(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
          }}
        />
        <button type="button" disabled={disabled || !trimmedKey || duplicate} onClick={add}>Add</button>
      </div>
      {duplicate ? <span class="ga-mcp-field-error">That key already exists.</span> : null}
    </div>
  );
}