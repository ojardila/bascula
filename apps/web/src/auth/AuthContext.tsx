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
import { ApiError } from "../api/errors";
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
  /**
   * `farmId` is how the second half of a multi-farm login works. There is no
   * token that is valid for two farms — the farm is baked into the access
   * token's claims — so choosing one means authenticating again, naming it.
   */
  login: (email: string, password: string, farmId?: string) => Promise<Session | LoginChoice>;
  logout: () => Promise<void>;
}

const ANONYMOUS: Principal = { role: "weigher", isSuperAdmin: false, farmStatus: "active" };

const AuthContext = createContext<AuthContextValue | null>(null);

/** The last `/v1/me` this device saw, so the app can open with no signal. */
const LAST_USER_KEY = "bascula.lastUser";

function rememberUser(user: MeUser): void {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
  } catch {
    // Storage full or blocked: the app still works online.
  }
}

function recalledUser(): MeUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? (JSON.parse(raw) as MeUser) : null;
  } catch {
    return null;
  }
}

function forgetUser(): void {
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Nothing to forget.
  }
}

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
        rememberUser(user);
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // NO SIGNAL IS NOT A LOGOUT. Opening the app at the plot with no
        // network used to throw the session away, and with it the only screen
        // that works offline. With the tokens still here and the last known
        // user on this device, the app opens as that user; the first request
        // that reaches the server settles whether the session is still good.
        const offline = e instanceof ApiError && (e.status === 0 || e.status >= 502);
        const last = offline ? recalledUser() : null;
        if (last) {
          setState({ status: "authenticated", user: last });
          return;
        }
        setTokens(null);
        forgetUser();
        setState({ status: "anonymous", user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The client fires this when a refresh fails; the session is already gone by
  // then, so all this does is move the UI out of the way.
  useEffect(() => {
    const onLogout = () => {
      forgetUser();
      setState({ status: "anonymous", user: null });
    };
    authEvents.addEventListener("logout", onLogout);
    return () => authEvents.removeEventListener("logout", onLogout);
  }, []);

  const login = useCallback(async (email: string, password: string, farmId?: string) => {
    const res = await api.login({ email, password, farmId });
    // A user who belongs to several farms gets the list back instead of a
    // session, and the screen asks which one before trying again.
    if ("choose" in res) return res;
    // `api.login` has already installed these — it has to, because it fetches
    // /v1/me before it can build the user. Setting them again is harmless and
    // keeps this function honest about what it leaves behind.
    setTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    rememberUser(res.user);
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
    forgetUser();
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
