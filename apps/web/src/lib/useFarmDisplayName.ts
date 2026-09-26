/**
 * The display name of the farm a host pins ("San José" for
 * san-jose.bascula.engp.io), for the front door and the login screen, where
 * nobody is signed in yet. `settled` turns true once the answer (or its
 * absence) is known, so a screen can fall back to the slug instead of
 * flashing it first.
 */
import { useEffect, useState } from "react";
import { api } from "../api/endpoints";

export function useFarmDisplayName(slug: string | null): { name: string | null; settled: boolean } {
  const [state, setState] = useState<{ slug: string | null; name: string | null }>({ slug: null, name: null });
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    api
      .farmName(slug)
      .then((res) => alive && setState({ slug, name: res.name?.trim() || null }))
      .catch(() => alive && setState({ slug, name: null }));
    return () => {
      alive = false;
    };
  }, [slug]);
  if (!slug) return { name: null, settled: true };
  return { name: state.slug === slug ? state.name : null, settled: state.slug === slug };
}
