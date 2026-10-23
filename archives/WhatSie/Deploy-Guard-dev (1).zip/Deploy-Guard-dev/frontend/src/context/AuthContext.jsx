import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getCurrentUser,
  loginUser,
  logoutUser,
  signupUser,
} from "../api/authApi.js";

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await getCurrentUser();
      setUser(response?.user || null);
      return response?.user || null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = useCallback(async (credentials) => {
    const response = await loginUser(credentials);
    setUser(response?.user || null);
    return response;
  }, []);

  const signup = useCallback(async (data) => {
    const response = await signupUser(data);
    setUser(response?.user || null);
    return response;
  }, []);

  const logout = useCallback(async () => {
    await logoutUser();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      role: user?.role || null,
      isAuthenticated: Boolean(user),
      isLoading,
      login,
      signup,
      logout,
      refreshUser,
    }),
    [isLoading, login, logout, refreshUser, signup, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
