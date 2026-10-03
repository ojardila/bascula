// SPDX-License-Identifier: MIT
/**
 * «Modo cosecha»: whether the farm's home screen shows the harvest-week
 * dashboard. Stored per farm on the server (farm_config.harvest_mode, read
 * from GET /v1/farm, written with PUT /v1/farm/harvest-mode).
 *
 * The last value seen is also kept in this browser, only so the home screen
 * does not open as one screen and jump to the other a second later while the
 * farm record loads. The server's answer always wins.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/endpoints";
import { setHarvestMode } from "../../api/harvest";
import { useAuth } from "../../auth/AuthContext";

const key = (farmId: string) => `bascula.harvestMode.${farmId}`;

function readCache(farmId: string | undefined): boolean | null {
  if (!farmId) return null;
  try {
    const v = window.localStorage.getItem(key(farmId));
    if (v === "1") return true;
    if (v === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeCache(farmId: string | undefined, on: boolean) {
  if (!farmId) return;
  try {
    window.localStorage.setItem(key(farmId), on ? "1" : "0");
  } catch {
    // A browser that refuses storage only loses the head start.
  }
}

export interface HarvestModeState {
  /** Null until known (no cached value and the server has not answered). */
  on: boolean | null;
  saving: boolean;
  /** Plain Spanish, for the person who flipped the switch. */
  error: string | null;
  set: (on: boolean) => Promise<void>;
}

export function useHarvestMode(): HarvestModeState {
  const { user } = useAuth();
  const farmId = user?.farm?.id;
  const [on, setOn] = useState<boolean | null>(() => readCache(farmId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.getFarm().then(
      (f) => {
        if (!live) return;
        const v = f.harvestMode ?? false;
        setOn(v);
        writeCache(farmId, v);
      },
      () => {
        // Unknown stays unknown: with nothing cached the home screen is the
        // ordinary one, which is what "off" looks like anyway.
        if (live) setOn((cur) => cur ?? false);
      },
    );
    return () => {
      live = false;
    };
  }, [farmId]);

  const set = useCallback(
    async (next: boolean) => {
      const before = on;
      setOn(next);
      setSaving(true);
      setError(null);
      try {
        const res = await setHarvestMode(next);
        setOn(res.harvestMode);
        writeCache(farmId, res.harvestMode);
      } catch {
        setOn(before);
        setError("No se pudo cambiar el modo cosecha. Revise la conexión e intente otra vez.");
      } finally {
        setSaving(false);
      }
    },
    [on, farmId],
  );

  return { on, saving, error, set };
}
