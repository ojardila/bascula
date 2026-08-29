/**
 * Who is logged in, and what the app is willing to show them.
 *
 * The context holds the session and derives a `Principal` from it; every
 * routing and navigation decision goes through `can()` and nothing reads
 * `user.role` directly. That indirection is the point: when a fourth role
 * appears, one table changes.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { api } from "../api/endpoints";
import { authEvents, getTokens, setTokens } from "../api/client";
import { can, isReadOnly, landingPath, visibleModules, type Action, type Principal } from "./permissions";
import type { LoginChoice, MeUser, Session } from "../api/types";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  user: MeUser | null;
}

interface AuthContextValue extends AuthState {
  principal: Principal;
  can: (action: Action) => boolean;
  readOnly: boolean;
  modules: ReturnType<typeof visibleModules>;
  landing: string;
  login: (email: string, password: string) => Promise<Session | LoginChoice>;
  logout: () => Promise<void>;
}

const ANONYMOUS: Principal = { role: "weigher", isSuperAdmin: false, farmStatus: "active" };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    // If there is a token in storage we do not know yet whether it is any
    // good, so the app shows a splash rather than flashing the login screen at
    // someone who is in fact logged in.
    status: getTokens() ? "loading" : "anonymous",
    user: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!getTokens()) return;
    api
      .me()
      .then((user) => {
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch(() => {
        if (!cancelled) {
          setTokens(null);
          setState({ status: "anonymous", user: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The client fires this when a refresh fails; the session is already gone by
  // then, so all this does is move the UI out of the way.
  useEffect(() => {
    const onLogout = () => setState({ status: "anonymous", user: null });
    authEvents.addEventListener("logout", onLogout);
    return () => authEvents.removeEventListener("logout", onLogout);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login({ email, password });
    if ("choose" in res) return res;
    setTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    setState({ status: "authenticated", user: res.user });
    return res;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // A logout that cannot reach the server still has to clear this browser.
    }
    setTokens(null);
    setState({ status: "anonymous", user: null });
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const principal: Principal = state.user
      ? {
          role: state.user.role,
          isSuperAdmin: state.user.isSuperAdmin,
          farmStatus: state.user.farm?.status ?? "active",
        }
      : ANONYMOUS;
    return {
      ...state,
      principal,
      can: (action: Action) => (state.user ? can(principal, action) : false),
      readOnly: state.user ? isReadOnly(principal) : false,
      modules: state.user ? visibleModules(principal) : [],
      landing: landingPath(principal),
      login,
      logout,
    };
  }, [state, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth fuera de <AuthProvider>");
  return ctx;
}
