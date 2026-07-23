// Header: brand, group strip, account menu, mobile drawer buttons.
import './Header.css';
import { drawerOpen } from '../state';
import { BRAND } from '../brand';
import { GroupStrip } from './GroupPicker';
import { UserMenu } from './UserMenu';

export function Header() {
  return (
    <header>
      <button
        type="button"
        class="icon-btn mobile-only"
        aria-label="Threads"
        onClick={() => { drawerOpen.threads.value = !drawerOpen.threads.value; drawerOpen.files.value = false; }}
      >{'\u2630'}</button>
      <span class="brand">{BRAND.name}</span>
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
