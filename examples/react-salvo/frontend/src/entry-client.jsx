import { createRoot } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import App from './App';

const url = window.location.href;
hydrateRoot(document, <App url={url} />);
