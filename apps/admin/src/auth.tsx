import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type AdminUser } from "./api.js";

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  can: (permission: string) => boolean;
  /** Called by the login flow once a full session exists. */
  onAuthenticated: (user: AdminUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  can: () => false,
  onAuthenticated: () => undefined,
  logout: async () => undefined,
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.onUnauthenticated = () => setUser(null);
    // Cold load: recover a session from the httpOnly refresh cookie, if any.
    void api.boot().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const onAuthenticated = useCallback((u: AdminUser) => setUser(u), []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const can = useCallback((permission: string) => user?.permissions.includes(permission) ?? false, [user]);

  return <AuthContext.Provider value={{ user, loading, can, onAuthenticated, logout }}>{children}</AuthContext.Provider>;
}
