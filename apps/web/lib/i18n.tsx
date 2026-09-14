import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '@/components/Icon';

export type Locale = 'zh' | 'en';

const LOCALE_COOKIE = 'omnistudio.locale';
const coreEnglish: Record<string, string> = {
  '页面不存在': 'Page not found',
  '加载中…': 'Loading…',
  '语言': 'Language',
};

let english: Record<string, string> = { ...coreEnglish };
let englishCatalog: Promise<Record<string, string>> | undefined;

export async function loadLocaleCatalog(locale: Locale) {
  if (locale !== 'en') return;
  englishCatalog ??= import('./locales/en').then((module) => {
    english = { ...coreEnglish, ...module.default };
    return english;
  });
  await englishCatalog;
}

export function getCookieLocale(): Locale | null {
  const cookie = document.cookie.split('; ').find((item) => item.startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie?.slice(`${LOCALE_COOKIE}=`.length);
  return value === 'zh' || value === 'en' ? value : null;
}

export function translateMessage(message: string, locale: Locale) {
  return locale === 'en' ? english[message] ?? message : message;
}

export function getInitialLocale(): Locale {
  return getCookieLocale() ?? (window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
}

type I18nContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: string) => string };
const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    void loadLocaleCatalog(next).then(() => {
      setLocaleState(next);
      document.cookie = `${LOCALE_COOKIE}=${next}; Max-Age=31536000; Path=/; SameSite=Lax`;
    });
  }, []);
  const t = useCallback((key: string) => locale === 'en' ? english[key] ?? key : key, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function choose(next: Locale) {
    setLocale(next);
    setOpen(false);
  }

  return <div className="language-switcher" ref={rootRef}>
    <button className="language-switcher-trigger" type="button" onClick={() => setOpen((current) => !current)} aria-haspopup="menu" aria-expanded={open} aria-label={t('语言')} title={t('语言')}>
      <Icon className="language-switcher-icon" name="globe" />
      <span>{locale === 'zh' ? '中文' : 'English'}</span><Icon className={`language-switcher-chevron ${open ? 'open' : ''}`} name="chevron-down" />
    </button>
    {open && <div className="language-switcher-menu" role="menu" aria-label={t('语言')}>
      <button className={`language-option ${locale === 'zh' ? 'active' : ''}`} type="button" role="menuitemradio" aria-checked={locale === 'zh'} onClick={() => choose('zh')}><span>中文</span>{locale === 'zh' && <Icon name="check" />}</button>
      <button className={`language-option ${locale === 'en' ? 'active' : ''}`} type="button" role="menuitemradio" aria-checked={locale === 'en'} onClick={() => choose('en')}><span>English</span>{locale === 'en' && <Icon name="check" />}</button>
    </div>}
  </div>;
}
