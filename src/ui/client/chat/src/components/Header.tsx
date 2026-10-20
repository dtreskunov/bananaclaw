// Header: brand, group strip, account menu, mobile drawer buttons.
import './Header.css';
import { drawerOpen, groupId } from '../state';
import { startNewThread } from '../actions';
import { BRAND } from '../brand';
import { GroupStrip } from './GroupPicker';
import { UserMenu } from './UserMenu';

export function Header() {
  return (
    <header class="app-header">
      <button
        type="button"
        class="icon-btn mobile-only"
        aria-label="Threads"
        onClick={() => { drawerOpen.threads.value = !drawerOpen.threads.value; drawerOpen.files.value = false; }}
      >{'\u2630'}</button>
      <span class="brand">{BRAND.name}</span>
      <button
        type="button"
        class="icon-btn mobile-only"
        title="New thread"
        aria-label="New thread"
        disabled={!groupId.value}
        onClick={startNewThread}
      ><span class="plus-glyph" aria-hidden="true">+</span></button>
      <GroupStrip />
      <UserMenu />
      <button
        type="button"
        class="icon-btn mobile-only"
        aria-label="Files"
        onClick={() => { drawerOpen.files.value = !drawerOpen.files.value; drawerOpen.threads.value = false; }}
      >{'\uD83D\uDCC1'}</button>
    </header>
  );
}
