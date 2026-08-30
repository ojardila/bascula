/**
 * Whether the text on these screens can be read in a lote at midday.
 *
 * `docs/usability.md` was written by three people sitting down with the
 * product. This is the one finding of theirs that a test can hold, because it
 * is the only one that is arithmetic: contrast has a formula, WCAG 2.1 defines
 * it, and a phone held at arm's length in direct sun is the case the formula's
 * thresholds exist for. Everything else in that document needs a person.
 *
 * ## What it actually checks
 *
 * Nothing in this app sets a grey. It dims the theme's own `onSurface` with
 * `opacity`, which is the right instinct — one colour, one knob — and it hides
 * the fact that the knob has a cliff in it. `opacity: 0.78` is 8.28:1 and
 * comfortable. `opacity: 0.6` is **4.45:1**, which is under AA's 4.5 by an
 * amount nobody would ever see reviewing a diff, and it was on eleven styles
 * across ten screens: every empty state, the labels under the figures on the
 * home screen, the struck-through voided rows.
 *
 * Worse, and this is why the file exists rather than a one-off fix:
 * `Account.tsx` rendered «no lo sé» — the four-state balance that
 * `usability.md` singles out as the distinction that "saves the most money and
 * almost no software makes it" — at `opacity: 0.35`, or **2.17:1**. The most
 * important sentence on the money screen was the least legible thing on it.
 *
 * So the check is: composite every `opacity` a screen's StyleSheet declares
 * against the surface it sits on, and refuse anything that lands under the
 * threshold for the size it is drawn at.
 *
 * ## What it deliberately does NOT check
 *
 * Colours given as hex — `#8a5a00` for debt, `#2e7d32` for the safe sentence,
 * `#b3261e` for conflicts — are pinned separately below, by name, because they
 * carry meaning and a test that swept them all would go off every time
 * somebody picked a nicer amber. And it says nothing about borders or icons:
 * those are non-text, their threshold is 3:1, and the only one that fails it
 * (`#f6b40e` on the sync cards, 1.79:1) is a 4 px accent stripe beside text
 * that says the same thing in words.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENS = join(HERE, "screens");

// ---- WCAG 2.1 relative luminance and contrast ----------------------------

type RGB = readonly [number, number, number];

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: RGB) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `opacity` does not change a colour; it composites it over what is behind. */
const over = (fg: RGB, bg: RGB, alpha: number): RGB =>
  [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ] as const;

const hex = (h: string): RGB =>
  [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ] as const;

/**
 * react-native-paper's MD3 light theme, which is the one this app ships.
 * A card is `surface`; body text is `onSurface`. Both are the values in
 * `@react-native-paper`'s `MD3LightTheme`, and they are what every `opacity`
 * in these files is silently multiplying.
 */
const SURFACE = hex("#fffbfe");
const ON_SURFACE = hex("#1c1b1f");

/** AA for body text. */
const AA = 4.5;
/** AA for large text: >= 24 px, or >= 18.66 px bold. */
const AA_LARGE = 3;

// ---- Reading the opacities off the screens -------------------------------

interface Dimmed {
  file: string;
  style: string;
  alpha: number;
}

/**
 * Every `<name>: { … opacity: <n> … }` in a screen's StyleSheet, plus the
 * inline `style={{ opacity: n }}` ones, which are just as visible to a person
 * and just as invisible to a reviewer.
 */
function dimmedStyles(): Dimmed[] {
  const out: Dimmed[] = [];
  for (const file of readdirSync(SCREENS).filter((f) => f.endsWith(".tsx"))) {
    const src = readFileSync(join(SCREENS, file), "utf8");
    for (const m of src.matchAll(/(\w+):\s*\{[^}]*?opacity:\s*(0?\.\d+)[^}]*\}/g))
      out.push({ file, style: m[1], alpha: Number(m[2]) });
    for (const m of src.matchAll(/style=\{\{\s*opacity:\s*(0?\.\d+)/g))
      out.push({ file, style: "(inline)", alpha: Number(m[1]) });
  }
  return out;
}

/**
 * The styles drawn at `displaySmall` or larger, which AA lets down to 3:1.
 *
 * Listed rather than inferred, and short on purpose: a style that wants the
 * lower bar has to be named here, which makes claiming it a decision somebody
 * takes rather than a default something drifts into.
 */
const LARGE_TEXT = new Set(["Account.tsx:zeroBig"]);

test("ningún texto atenuado de una pantalla baja del contraste AA", () => {
  const failures: string[] = [];

  for (const { file, style, alpha } of dimmedStyles()) {
    const effective = over(ON_SURFACE, SURFACE, alpha);
    const ratio = contrast(effective, SURFACE);
    const floor = LARGE_TEXT.has(`${file}:${style}`) ? AA_LARGE : AA;
    if (ratio < floor)
      failures.push(
        `${file} · ${style}: opacity ${alpha} da ${ratio.toFixed(2)}:1, hace falta ${floor}:1`,
      );
  }

  assert.deepEqual(failures, [], `contraste insuficiente:\n${failures.join("\n")}`);
});

test("la arruga de opacity 0.6 no puede volver: está justo por debajo del umbral", () => {
  // The number this whole file was written around. It is worth asserting on
  // its own, because "0.6 looks fine" is exactly what somebody will think.
  const ratio = contrast(over(ON_SURFACE, SURFACE, 0.6), SURFACE);
  assert.ok(ratio < AA, `0.6 daba ${ratio.toFixed(2)}:1 y ahora pasa: revisa el tema`);
  assert.ok(contrast(over(ON_SURFACE, SURFACE, 0.7), SURFACE) >= AA, "0.7 tiene que pasar");
});

test("«no lo sé» se dibuja a contraste pleno, no atenuado como un $0", () => {
  // `usability.md`: "it is not zero: it is that we do not know" is protected as
  // the distinction that saves the most money. Rendering it in the same grey
  // the screen uses for "nothing to see here" is the one way to lose it
  // without deleting a line of it.
  const src = readFileSync(join(SCREENS, "Account.tsx"), "utf8");
  const at = src.indexOf('t("pay.balanceUnknownShort")');
  assert.ok(at !== -1, "la pantalla ya no dice «no lo sé»");
  const tag = src.lastIndexOf("<Text", at);
  const style = src.slice(tag, at);
  assert.ok(
    !style.includes("zeroBig"),
    "«no lo sé» volvió a compartir el gris del $0, que es lo contrario de lo que significa",
  );
  assert.match(style, /styles\.unknownBig/);
  assert.ok(
    !/unknownBig: \{[^}]*opacity/.test(src),
    "unknownBig no puede llevar opacity: es la respuesta a la pregunta de la pantalla",
  );
});

test("los colores que significan algo siguen siendo legibles sobre la tarjeta", () => {
  // Not a sweep: these five carry meaning, and each is pinned by name so that
  // changing one is a decision. Red is only ever conflicts, on this phone, and
  // that discipline is what makes red mean something (`usability.md`).
  const named: [string, string, number][] = [
    ["verde de «no se toca tu teléfono»", "#2e7d32", AA],
    ["rojo de conflicto", "#b3261e", AA],
    ["ámbar de deuda", "#8a5a00", AA],
    ["azul de saldo a favor", "#3949ab", AA],
    ["rojo de quitar la foto", "#c0392b", AA],
  ];
  const failures = named
    .map(([label, colour, floor]): [string, number, number] => [
      label,
      contrast(hex(colour), SURFACE),
      floor,
    ])
    .filter(([, ratio, floor]) => ratio < floor)
    .map(([label, ratio, floor]) => `${label}: ${ratio.toFixed(2)}:1 < ${floor}:1`);

  assert.deepEqual(failures, []);
});

test("el texto sobre el verde oscuro del inicio también se lee", () => {
  // The hero on `Home.tsx` inverts: pale text on a dark green. It is the first
  // thing anybody sees and the only place in the app that does this.
  const HERO = hex("#1b5e20");
  for (const colour of ["#cdeccb", "#eafbe7"]) {
    const ratio = contrast(hex(colour), HERO);
    assert.ok(ratio >= AA, `${colour} sobre el verde del hero: ${ratio.toFixed(2)}:1`);
  }
});
