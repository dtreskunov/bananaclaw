// Shared tab bar — scrollable horizontal strip on desktop, dropdown
// button + modal sheet on mobile. Both presentations are always in the
// DOM and toggled with `display:none` at the 720px breakpoint, so the
// viewport swap is pure CSS (no resize listener, no remount). Each
// caller passes a flat list of items plus optional "extras" — trailing
// non-tab buttons that appear after the tabs on desktop and at the
// bottom of the sheet on mobile (e.g. "More agents…", "+ New agent").
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import './TabBar.css';

export interface TabItem {
  id: string;
  label: string;
  /** Optional second line under the label (e.g. relative activity time). */
  sublabel?: string;
  /** Keep an empty second row when sibling tabs display sublabels. */
  reserveSublabel?: boolean;
  /** Tooltip / aria title. */
  title?: string;
  /** Extra className for per-item styling (e.g. dimmed / accent). */
  className?: string;
}

export interface TabExtra {
  key: string;
  label: string;
  /** Optional second line under the label. */
  sublabel?: string;
  /** Keep an empty second row when sibling tabs display sublabels. */
  reserveSublabel?: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
  ariaHaspopup?: 'dialog';
}

interface TabBarProps {
  ariaLabel: string;
  activeId: string | null;
  items: TabItem[];
  onSelect: (id: string) => void;
  extras?: TabExtra[];
  /** Applied to both the desktop strip and the mobile dropdown button so the
   *  caller can layout the bar (e.g. `flex:1; min-width:0` from a header). */
  className?: string;
  /** Header text for the mobile sheet. Defaults to `ariaLabel`. */
  mobileSheetTitle?: string;
}

export function TabBar(props: TabBarProps): JSX.Element {
  const { ariaLabel, activeId, items, onSelect, extras, className, mobileSheetTitle } = props;
  const navRef = useRef<HTMLElement | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Auto-scroll the active tab into view when it changes.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  // Close the sheet on Escape / when the modal is open.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const activeItem = items.find((it) => it.id === activeId) ?? null;
  const dropdownLabel = activeItem?.label ?? '';
  const sheetTitle = mobileSheetTitle ?? ariaLabel;

  const cls = (base: string): string => (className ? `${base} ${className}` : base);

  return (
    <>
      <nav
        ref={navRef as unknown as (el: HTMLElement | null) => void}
        class={cls('tab-bar-strip')}
        role="tablist"
        aria-label={ariaLabel}
      >
        {items.map((it) => {
          const isActive = it.id === activeId;
          return (
            <button
              type="button"
              key={it.id}
              role="tab"
              aria-selected={isActive}
              title={it.title}
              class={`tab-item${isActive ? ' active' : ''}${it.className ? ` ${it.className}` : ''}`}
              onClick={() => onSelect(it.id)}
            >
              <span class="tab-item-label">{it.label}</span>
              {it.sublabel || it.reserveSublabel ? (
                <span class="tab-item-sublabel" aria-hidden={it.sublabel ? undefined : 'true'}>
                  {it.sublabel}
                </span>
              ) : null}
            </button>
          );
        })}
        {extras?.map((ex) => (
          <button
            type="button"
            key={ex.key}
            title={ex.title}
            aria-haspopup={ex.ariaHaspopup}
            class={`tab-item tab-extra${ex.className ? ` ${ex.className}` : ''}`}
            onClick={ex.onClick}
          >
            <span class="tab-item-label">{ex.label}</span>
            {ex.sublabel || ex.reserveSublabel ? (
              <span class="tab-item-sublabel" aria-hidden={ex.sublabel ? undefined : 'true'}>
                {ex.sublabel}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <button
        type="button"
        class={cls('tab-bar-dropdown')}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        onClick={() => setSheetOpen(true)}
      >
        <span class="tab-bar-dropdown-label">{dropdownLabel}</span>
        <span class="tab-bar-dropdown-caret" aria-hidden="true">{'\u25BE'}</span>
      </button>

      {sheetOpen ? (
        <TabBarSheet
          title={sheetTitle}
          items={items}
          extras={extras}
          activeId={activeId}
          onSelect={(id) => { setSheetOpen(false); onSelect(id); }}
          onExtra={(ex) => { setSheetOpen(false); ex.onClick(); }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}

interface TabBarSheetProps {
  title: string;
  items: TabItem[];
  extras?: TabExtra[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onExtra: (ex: TabExtra) => void;
  onClose: () => void;
}

function TabBarSheet(props: TabBarSheetProps): JSX.Element {
  const { title, items, extras, activeId, onSelect, onExtra, onClose } = props;
  const onBackdrop = (e: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).classList.contains('settings-backdrop')) onClose();
  };
  return (
    <div class="settings-backdrop tab-bar-sheet-backdrop" onClick={onBackdrop}>
      <div
        class="settings-modal tab-bar-sheet"
        role="dialog"
        aria-label={title}
        style="max-width:480px"
      >
        <header class="settings-head">
          <span class="title">{title}</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={onClose}>{'\u2715'}</button>
        </header>
        <div class="settings-body tab-bar-sheet-list">
          {items.map((it) => {
            const isActive = it.id === activeId;
            return (
              <button
                type="button"
                key={it.id}
                class={`tab-bar-sheet-row${isActive ? ' active' : ''}${it.className ? ` ${it.className}` : ''}`}
                aria-current={isActive ? 'true' : undefined}
                title={it.title}
                onClick={() => onSelect(it.id)}
              >
                <span class="tab-bar-sheet-row-name">{it.label}</span>
                {it.sublabel ? <span class="tab-bar-sheet-row-sub">{it.sublabel}</span> : null}
              </button>
            );
          })}
          {extras?.length ? (
            <>
              <div class="tab-bar-sheet-divider" aria-hidden="true" />
              {extras.map((ex) => (
                <button
                  type="button"
                  key={ex.key}
                  class={`tab-bar-sheet-row tab-bar-sheet-extra${ex.className ? ` ${ex.className}` : ''}`}
                  title={ex.title}
                  onClick={() => onExtra(ex)}
                >
                  <span class="tab-bar-sheet-row-name">{ex.label}</span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
