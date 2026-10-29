// Header: brand, group strip, account menu, mobile drawer buttons.
import './Header.css';
import { credentialsOpen, drawerOpen, groupId } from '../state';
import { openChat, openCredentials } from '../credentials-navigation';
import { startNewThread } from '../actions';
import { BRAND } from '../brand';
import { GroupStrip } from './GroupPicker';
import { UserMenu } from './UserMenu';

export function Header() {
  return (
    <header class="app-header">
      {!credentialsOpen.value ? <button
        type="button"
        class="icon-btn mobile-only"
        aria-label="Threads"
        onClick={() => { drawerOpen.threads.value = !drawerOpen.threads.value; drawerOpen.files.value = false; }}
      >{'\u2630'}</button> : null}
      <span class="brand">{BRAND.name}</span>
      {!credentialsOpen.value ? <button
        type="button"
        class="icon-btn mobile-only"
        title="New thread"
        aria-label="New thread"
        disabled={!groupId.value}
        onClick={startNewThread}
      ><span class="plus-glyph" aria-hidden="true">+</span></button> : null}
      <GroupStrip />
      <nav class="primary-navigation" aria-label="Primary">
        <button type="button" aria-current={!credentialsOpen.value ? 'page' : undefined} onClick={openChat}>Chat</button>
        <button type="button" aria-current={credentialsOpen.value ? 'page' : undefined} onClick={() => openCredentials()}>Credentials</button>
      </nav>
      <UserMenu />
      {!credentialsOpen.value ? <button
        type="button"
        class="icon-btn mobile-only"
        aria-label="Files"
        onClick={() => { drawerOpen.files.value = !drawerOpen.files.value; drawerOpen.threads.value = false; }}
      >{'\uD83D\uDCC1'}</button> : null}
    </header>
  );
}
