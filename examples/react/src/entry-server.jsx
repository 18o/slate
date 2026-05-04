import { renderToString } from 'react-dom/server';
import App from './App';

export function render({ url }) {
  const html = renderToString(<App url={url} />);
  return html;
}
