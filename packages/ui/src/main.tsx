import { render } from 'solid-js/web';
import App from './App';
import Viewer from './Viewer';
import { initializeTheme } from './theme';
import './theme.css';
import './styles.css';
import './viewer.css';

initializeTheme();

render(
  () => (new URLSearchParams(location.search).get('viewer') === '1' ? <Viewer /> : <App />),
  document.getElementById('root')!,
);
