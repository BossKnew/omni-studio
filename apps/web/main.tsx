import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './app/globals.css';
import { getInitialLocale, I18nProvider, loadLocaleCatalog } from '@/lib/i18n';

void loadLocaleCatalog(getInitialLocale()).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode><I18nProvider><App /></I18nProvider></StrictMode>,
  );
});
