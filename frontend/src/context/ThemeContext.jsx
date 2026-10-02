import { createContext, useCallback, useEffect, useMemo, useState } from "react";

export const ThemeContext = createContext(null);
const STORAGE_KEY = "deployguard-theme";
const PREFERENCES = new Set(["system", "light", "dark"]);

function storedPreference() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.has(value) ? value : "system";
  } catch {
    return "system";
  }
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Theme preference: "system" follows the OS; the resolved theme is applied to <html>. */
export function ThemeProvider({ children }) {
  const [preference, setPreferenceState] = useState(storedPreference);
  const [system, setSystem] = useState(systemTheme);
  const theme = preference === "system" ? system : preference;

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return undefined;
    const onChange = () => setSystem(query.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f6f4" : "#0e0f11");
  }, [theme]);

  const setPreference = useCallback((value) => {
    if (!PREFERENCES.has(value)) return;
    setPreferenceState(value);
    try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage unavailable: preference lasts this session */ }
  }, []);

  const value = useMemo(() => ({ preference, setPreference, theme }), [preference, setPreference, theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
