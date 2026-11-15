import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const KEY = 'yuktiops.theme'; // keep in sync with public/theme.js
const ThemeContext = createContext(null);

function read() {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(read);
  const [prefersDark, setPrefersDark] = useState(systemDark);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => setPrefersDark(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);
  const setTheme = useCallback((next) => {
    setThemeState(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage can be unavailable */
    }
  }, []);
  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
