import { render } from 'solid-js/web';
import App from './App';
import Viewer from './Viewer';
import { initializeTheme } from './theme';
import { initializeMotion } from './motion';
import { installDesktopShell } from './desktop';
import './tokens.css';
import './ui';
import './styles.css';
import './viewer.css';

initializeTheme();
initializeMotion();
installDesktopShell();

const params = new URLSearchParams(location.search);
if (import.meta.env.DEV && params.get('design') === '1') {
  // The reference page ships only in development builds.
  void import('./DesignReference').then(({ default: DesignReference }) =>
    render(() => <DesignReference />, document.getElementById('root')!),
  );
} else
  render(
    () => (params.get('viewer') === '1' ? <Viewer /> : <App />),
    document.getElementById('root')!,
  );
