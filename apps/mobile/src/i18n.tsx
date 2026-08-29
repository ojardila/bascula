import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Prefs } from "./db";

export type { Lang } from "../../../packages/shared/src/format.ts";
import type { Lang } from "../../../packages/shared/src/format.ts";
export { translate, weekTag } from "./strings";
import { translate } from "./strings";
export {
  formatMoney,
  formatNumber,
  formatWeekRange,
  formatDay,
  mondayOf,
  weekNumber,
} from "../../../packages/shared/src/format.ts";
import { formatMoney, formatNumber, mondayOf, parseDay, addDays } from "../../../packages/shared/src/format.ts";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const LangContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
  money: (n: number) => string;
  num: (n: number) => string;
}>({
  lang: "es",
  setLang: () => {},
  t: (k) => k,
  money: (n) => formatMoney(n, "es"),
  num: (n) => formatNumber(n, "es"),
});

export function LangProvider({ children }: { children: ReactNode }) {
  // Runs during the first render, before initDb() gets a chance in its effect,
  // so a broken database would throw here — outside any try/catch — and the
  // error screen that hangs below this provider would never mount.
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return Prefs.getLang();
    } catch {
      return "es";
    }
  });
  const value = useMemo(
    () => ({
      lang,
      setLang: (l: Lang) => {
        try {
          Prefs.setLang(l);
        } catch {
          /* keep the in-memory choice even if it cannot be persisted */
        }
        setLangState(l);
      },
      t: (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
      money: (n: number) => formatMoney(n, lang),
      num: (n: number) => formatNumber(n, lang),
    }),
    [lang],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT() {
  return useContext(LangContext);
}
