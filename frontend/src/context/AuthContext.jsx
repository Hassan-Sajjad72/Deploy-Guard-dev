import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentUser, logoutUser } from "../api/authApi.js";

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const refreshInFlight = useRef(null);
  const authStateGeneration = useRef(0);

  const refreshUser = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const generation = ++authStateGeneration.current;
    let request;
    request = getCurrentUser()
      .then((response) => {
        if (generation !== authStateGeneration.current) return null;
        const nextUser = response?.user || null;
        setUser(nextUser);
        return nextUser;
      })
      .catch(() => {
        if (generation === authStateGeneration.current) setUser(null);
        return null;
      })
      .finally(() => {
        if (generation === authStateGeneration.current) setIsLoading(false);
        if (refreshInFlight.current === request) refreshInFlight.current = null;
      });
    refreshInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    function refreshOnReturn() {
      if (document.visibilityState === "visible") void refreshUser();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [refreshUser]);

  const logout = useCallback(async () => {
    authStateGeneration.current += 1;
    refreshInFlight.current = null;
    try {
      await logoutUser();
    } finally {
      setUser(null);
      setIsLoading(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      role: user?.role || null,
      isAuthenticated: Boolean(user),
      isLoading,
      logout,
      refreshUser,
    }),
    [isLoading, logout, refreshUser, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
