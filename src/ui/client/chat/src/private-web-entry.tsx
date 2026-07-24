import { render } from 'preact';
import { PrivateWebView } from './components/PrivateWebView';

const root = document.getElementById('private-web-root');
if (root) {
  const groupId = root.dataset.groupId;
  const path = root.dataset.path;
  if (groupId && path) render(<PrivateWebView groupId={groupId} path={path} title={path} />, root);
}