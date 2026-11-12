import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';
import './features.css';
import './privacy.css';

createRoot(document.getElementById('root')!).render(<App />);
