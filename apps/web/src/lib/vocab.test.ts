/**
 * THE TEST THAT KEEPS THE VOCABULARY FROM DRIFTING APART AGAIN.
 *
 * `vocab.ts` is worth little if tomorrow somebody hand-writes "Parcelas" on a
 * new screen: three sprints later we are back to two words for the same piece
 * of land and a manhunt through thirty-seven files. So this test READS THE
 * SOURCE, strips the comments off it, and fails if it finds one of the retired
 * words anywhere it can be read.
 *
 * WHY READ FILES INSTEAD OF RENDERING SCREENS. A render test only sees the
 * screens somebody remembered to put in it, and the failure worth preventing
 * is precisely the new screen nobody added to the list. This sees everything
 * under `src/`, including whatever gets written tomorrow.
 *
 * THE COMMENTS ARE STRIPPED on purpose: this file and several others EXPLAIN
 * why "parcela" was retired, and a test that banned telling the story would
 * force the reason for the change to be deleted along with the change.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMPLOYEE, GROSS_SETTLED, LEDGER_KIND_LABEL, PLOT, PAY_MODE_LABEL, PROVISIONAL,
  PICKER,
} from "./vocab";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strips comments without breaking strings.
 *
 * A `replace` with a regular expression eats the double slash of
 * `"https://…"` and, the other way round, calls a comment closed when it is
 * really inside a template literal. So this walks the text character by
 * character keeping track of where it is. It is the only way the test does not
 * lie in either direction.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "'" | '"' | "`";
  let state: State = "code";
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; i += 2; continue; }
      // Newlines are kept so the line number in the error message is still
      // the one in the real file.
      if (c === "\n") out += c;
      i++; continue;
    }
    // Inside a string. `\` escapes whatever comes next.
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === state) state = "code";
    out += c; i++;
  }
  return out;
}

interface Hit { file: string; line: number; text: string }

/** Every match of `pattern` in the code (comments stripped) of `files`. */
function hits(files: string[], pattern: RegExp): Hit[] {
  const found: Hit[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    code.split("\n").forEach((text, n) => {
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) {
        found.push({ file: relative(SRC, file), line: n + 1, text: text.trim() });
      }
    });
  }
  return found;
}

const show = (h: Hit[]) => h.map((x) => `${x.file}:${x.line}  ${x.text}`).join("\n");

const ALL = walk(SRC);
const isTest = (f: string) => /\.test\.tsx?$/.test(f);
const under = (...dirs: string[]) => (f: string) =>
  dirs.some((d) => f.includes(join(SRC, d) + "/"));

/** Everything a person can end up reading: screens and their helpers. */
const PRODUCT = ALL.filter(
  (f) =>
    !isTest(f) &&
    !f.endsWith(join(SRC, "lib", "vocab.ts")) &&
    !under("mocks")(f) &&
    !under("test")(f),
);

/** The screens only. Not one word of accountancy fits here. */
const SCREENS = PRODUCT.filter((f) => f.endsWith(".tsx"));

describe("the land is called \"lote\", in exactly one place", () => {
  it("nobody hand-writes \"parcela\" anywhere in the product", () => {
    // The only file allowed to name it is the one that retires it, and that
    // one is off the list. `App.tsx` names it only to redirect it, which the
    // test below checks. If this fails: import `PLOT` from `lib/vocab`.
    const offenders = hits(PRODUCT, /parcela/i).filter((h) => !h.file.endsWith("App.tsx"));
    expect(show(offenders)).toBe("");
  });

  it("and in `App.tsx` it survives only to redirect the old link", () => {
    const inApp = hits(PRODUCT.filter((f) => f.endsWith("App.tsx")), /parcela/i);
    expect(inApp.length).toBeGreaterThan(0);
    for (const h of inApp) expect(h.text).toMatch(/Navigate|Redirect|replace\(/);
  });

  it("nor the old route, except the redirect that keeps saved links working", () => {
    const offenders = hits(PRODUCT, /["'`]\/parcelas/).filter(
      (h) => !h.file.endsWith("App.tsx"),
    );
    expect(show(offenders)).toBe("");
  });

  it("and `PLOT` says what the phone says", () => {
    expect(PLOT.one).toBe("lote");
    expect(PLOT.path).toBe("/lotes");
  });
});

describe("how people get paid is said in the language of the trade", () => {
  it("not one \"unidad de trabajo\" or \"unidad de tiempo\" is left", () => {
    expect(show(hits(PRODUCT, /unidad(es)? de (trabajo|tiempo)/i))).toBe("");
  });

  it("and \"destajo\" —how coffee is paid for— exists", () => {
    expect(PAY_MODE_LABEL.work_unit).toMatch(/destajo/i);
    expect(PAY_MODE_LABEL.time_unit).toMatch(/jornal/i);
    expect(PAY_MODE_LABEL.contract).toMatch(/contrato/i);
  });
});

describe("a figure that can still move is called \"provisional\" and nothing else", () => {
  it("\"estimado\" does not survive on any screen", () => {
    expect(show(hits(SCREENS, /\bestimad[oa]s?\b/i))).toBe("");
  });

  it("and the paper already called it that, which is why it won", () => {
    expect(PROVISIONAL).toBe("provisional");
    const paper = readFileSync(join(SRC, "features/documents/documents.ts"), "utf8");
    expect(paper).toContain("PROVISIONAL");
  });
});

describe("the ledger does not talk accountancy at the coffee farmer", () => {
  it("\"devengo\" and \"reverso\" appear on no screen", () => {
    expect(show(hits(SCREENS, /\b(devengos?|reversos?)\b/i))).toBe("");
  });

  it("the entry kinds are said in farm words", () => {
    expect(LEDGER_KIND_LABEL.devengo).toBe("ganado");
    expect(LEDGER_KIND_LABEL.reverso).toBe("corrección");
    expect(LEDGER_KIND_LABEL.deduccion).toBe("descuento");
  });
});

describe("the store is not a bank statement", () => {
  it("no \"movimientos\" are left in Inventory", () => {
    const inventory = PRODUCT.filter(under("features/inventory"));
    expect(inventory.length).toBeGreaterThan(0);
    expect(show(hits(inventory, /movimientos?/i))).toBe("");
  });

  it("but \"saldo a favor\" and \"bruto\" stay: they are farm words", () => {
    expect(GROSS_SETTLED).toBe("Bruto liquidado");
    expect(EMPLOYEE.One).toBe("Empleado");
  });
});

/**
 * THE TWO WORDS FOR THE SAME PERSON, AND WHY "EMPLEADO" WON.
 *
 * The console says "empleado" and the phone says "recolector", and both of
 * them print it. The console's word wins in the console because it is already
 * on its paper —the signature line and the payroll sheet column— and because
 * the console administers people who do not pick coffee a single day. And
 * "recolector" stays in Harvest, which is where it genuinely means *whoever
 * picked*.
 */
describe("the person is called \"empleado\", and \"recolector\" only where that is what they are", () => {
  it("Harvest still says recolector: there it is a role, not a record", () => {
    expect(PICKER.Many).toBe("Recolectores");
    const harvest = PRODUCT.filter(under("features/harvest"));
    expect(hits(harvest, /PICKER\./).length).toBeGreaterThan(0);
  });

  it("and outside Harvest nobody calls an employee a recolector", () => {
    const elsewhere = SCREENS.filter((f) => !under("features/harvest")(f));
    expect(show(hits(elsewhere, /recolector/i))).toBe("");
  });
});

/**
 * THE PAPER, PROTECTED BY A TEST OF ITS OWN.
 *
 * The above stops the screen from talking accountancy again. This stops the
 * opposite: a vocabulary sprint changing the words on the receipt somebody
 * already signed. If one of these strings has to move, let it be a decision
 * taken with this test in front of you and not the side effect of a `sed`.
 */
describe("what is printed does not move for a sprint about words", () => {
  const paper = readFileSync(join(SRC, "features/documents/documents.ts"), "utf8");

  it.each([
    "Recibo de pago",
    "Liquidación",
    "Firma del empleado",
    "Firma por la finca",
    "Bruto liquidado",
    "Total liquidado",
    "PROVISIONAL",
    "PLANILLA PARCIAL",
    "Empleado",
  ])("\"%s\" is still on the paper", (word) => {
    expect(paper).toContain(word);
  });

  it("and a voided settlement's block keeps the ledger's own words", () => {
    // It is the ONLY printed place they appear, and they appear there to be
    // reconciled against the ledger three weeks later. See the note on
    // `LEDGER_KIND_LABEL`.
    expect(paper).toContain("devengo");
    expect(paper).toContain("reverso");
  });
});
