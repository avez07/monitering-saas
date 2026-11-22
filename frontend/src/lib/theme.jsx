import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const KEY = 'yuktiops.theme'; // keep in sync with public/theme.js
const PALETTE_KEY = 'yuktiops.palette'; // keep in sync with public/theme.js
export const PALETTES = [
  { id: 'warm', label: 'Warm clay', color: 'hsl(17 72% 38%)' },
  { id: 'teal', label: 'Dusty teal', color: 'hsl(176 68% 36%)' },
  { id: 'rose', label: 'Rose', color: 'hsl(346 68% 36%)' },
  { id: 'apricot', label: 'Apricot', color: 'hsl(27 68% 36%)' },
];
function readPalette() {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    return PALETTES.some((p) => p.id === v) ? v : 'warm';
  } catch {
    return 'warm';
  }
}
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
  const [palette, setPaletteState] = useState(readPalette);
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
  useEffect(() => {
    const root = document.documentElement;
    if (palette === 'warm') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', palette);
  }, [palette]);
  const setPalette = useCallback((next) => {
    setPaletteState(next);
    try {
      if (next === 'warm') localStorage.removeItem(PALETTE_KEY);
      else localStorage.setItem(PALETTE_KEY, next);
    } catch {
      /* storage can be unavailable */
    }
  }, []);
  const setTheme = useCallback((next) => {
    setThemeState(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage can be unavailable */
    }
  }, []);
  const value = useMemo(
    () => ({ theme, resolved, setTheme, palette, setPalette }),
    [theme, resolved, setTheme, palette, setPalette],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
