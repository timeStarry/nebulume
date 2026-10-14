import { render } from 'solid-js/web';
import App from './App';
import Viewer from './Viewer';
import './styles.css';

render(
  () => (new URLSearchParams(location.search).get('viewer') === '1' ? <Viewer /> : <App />),
  document.getElementById('root')!,
);
