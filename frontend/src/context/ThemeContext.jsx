import { createContext, useCallback, useEffect, useMemo, useState } from "react";

export const ThemeContext = createContext(null);

function initialTheme() {
  return "light";
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("deployguard-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme("light"), []);
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
