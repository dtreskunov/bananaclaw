import { render } from 'preact';
import { PrivateWebView } from './components/PrivateWebView';

const root = document.getElementById('private-web-root');
if (root) {
  const groupId = root.dataset.groupId;
  const path = root.dataset.path;
  if (groupId && path) {
    const mount = (): void => {
      render(
        <PrivateWebView groupId={groupId} path={path} title={path} fragment={window.location.hash} />,
        root,
      );
    };
    mount();
    // A fragment-only navigation does not reload this document, so re-render to
    // hand the new deep-link input to the application.
    window.addEventListener('hashchange', mount);
  }
}