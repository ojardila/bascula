/**
 * The screen that moves a farm's nómina, and the sentences it must not lose.
 *
 * `seasonImport.test.ts` covers the machinery: the export, the wire, the
 * retry, the refusal. This file covers the part a person actually meets, and
 * it exists because the two properties below were true only by somebody having
 * written them once and nobody having deleted them since.
 *
 *   1. **«No se subió nada» y «tu teléfono sigue exactamente igual».** That is
 *      the property `docs/sincronizacion.md` §8's whole plan rests on: a
 *      failed mudanza costs nothing, so trying it is not brave. It was in the
 *      source and in the dictionaries and in nothing that would notice its
 *      removal. A person reading a red card has no other way to learn it.
 *
 *   2. **Who is allowed to press it.** The server's permission table says
 *      `ActionImportSeason: {Roles: owners}` and `owners` is exactly
 *      `[]domain.Role{domain.RoleOwner}`. The screen gated on `owner` and the
 *      sentence beside the gate said «solo el dueño o un administrador» — in
 *      all three languages. The one person likeliest to read that card is an
 *      administrator, because they are the one it just stopped, and it told
 *      them they could do the thing the disabled button says they cannot.
 *
 * Both are checked against the screen's SOURCE rather than by rendering it.
 * That is not the weaker check here: rendering four states of one screen would
 * not catch the fifth branch somebody adds next sprint, and reading the source
 * does. It is the same discipline `flagOff.test.ts` uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { translate } from "./strings.ts";
import { LEDGER_KINDS } from "../../../packages/shared/src/enums.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), "utf8");
const LANGS = ["es", "en", "pt"] as const;

const SCREEN = "screens/SeasonImport.tsx";

// ---- 1. The sentence that makes the mudanza safe to attempt --------------

test("cada rama de fallo dice que no se subió nada y que el teléfono sigue igual", () => {
  const src = read(SCREEN);

  // The failure card is one card with three bodies — rejected, refused, broke
  // — precisely so that these two lines cannot be written three times and
  // forgotten once. Pinning that structure is what keeps it that way.
  assert.match(src, /t\("import\.failTitle"\)/, "el título de fallo no está");
  assert.match(src, /t\("import\.failSafe"\)/, "la frase de seguridad no está");

  const failCard = src.slice(src.indexOf("const rejected ="));
  for (const body of ["import.rejectedBody", "import.refusedBody", "import.brokeBody"])
    assert.ok(failCard.includes(body), `${body} no se muestra en ninguna rama`);

  // And the safe sentence is rendered OUTSIDE the three-way branch, above it,
  // so no branch can be added that omits it.
  const safeAt = failCard.indexOf('t("import.failSafe")');
  const branchAt = failCard.indexOf("rejected\n");
  assert.ok(
    safeAt !== -1 && (branchAt === -1 || safeAt < branchAt),
    "la frase de seguridad tiene que ir antes de la explicación, no dentro de una rama",
  );
});

test("la promesa de que no se toca el teléfono se dice antes, durante y después", () => {
  const src = read(SCREEN);
  // Three occurrences of `import.safety`: the hero card, the confirmation
  // dialog, and the progress card. The minutes in between the button and the
  // answer are exactly when somebody on a bad link starts wondering whether
  // they have broken the farm's payroll.
  const occurrences = src.split('t("import.safety")').length - 1;
  assert.ok(
    occurrences >= 3,
    `la frase de seguridad aparece ${occurrences} veces; hacen falta al menos 3 (antes, en la confirmación y durante)`,
  );
});

test("nada se sube sin pasar por una confirmación que dice cuánto dinero viaja", () => {
  const src = read(SCREEN);
  // `usability.md` §"What must be protected": the console's crew payroll is
  // the model, and what makes it the model is that the confirmation names what
  // moves. A row count is not what moves; the money is.
  assert.match(src, /setConfirming\(true\)/, "el botón ya no abre una confirmación");
  assert.match(src, /t\("import\.confirmMoney"/, "la confirmación no dice cuánto dinero viaja");
  // And the upload is only reachable from inside the dialog.
  const upload = src.indexOf("void upload()");
  assert.ok(upload !== -1, "el envío ya no sale de la confirmación");
});

test("un rechazo por saldos no ofrece un botón de reintentar", () => {
  const src = read(SCREEN);
  // Repeating a 409 produces the same 409. The button would be an invitation
  // to press it until it works, and it never will until somebody finds out why
  // the arithmetic differs.
  assert.match(src, /\{!rejected && \(\s*<Button/, "el reintento no está condicionado al rechazo");
});

// ---- 2. Who may press it ------------------------------------------------

test("la pantalla ofrece la mudanza solo al dueño, como la tabla de permisos", () => {
  const src = read(SCREEN);
  assert.match(
    src,
    /const mayImport = status\.role === "owner";/,
    "la puerta ya no es exactamente el dueño",
  );
});

test("y la frase que la acompaña no le promete a un administrador lo que el servidor le niega", () => {
  // The regression, named. `ActionImportSeason: {Roles: owners}` on the server
  // means an administrator gets a 403 — after uploading the whole season, if
  // the phone had let them start. The sentence must not say otherwise in any
  // language.
  const forbidden = [
    /administrador/i,
    /administrator/i,
    /\badmin\b/i,
  ];
  for (const lang of LANGS) {
    const said = translate(lang, "import.noMoney");
    assert.notEqual(said, "import.noMoney", `import.noMoney falta en ${lang}`);
    for (const pattern of forbidden)
      assert.ok(
        !pattern.test(said) || /ni un|neither|nem um/i.test(said),
        `import.noMoney en ${lang} le dice a un administrador que puede: «${said}»`,
      );
  }
});

// ---- 3. What the person is told while nothing appears to happen ----------

test("la espera lleva reloj, tamaño, plazo y una explicación del tramo callado", () => {
  const src = read(SCREEN);
  for (const key of [
    "import.elapsed", // the clock: the only evidence the process is alive
    "import.size", // why it takes what it takes
    "import.waitUntil", // and when it will give up, so the wait has an end
    "import.dontClose",
    "import.tail", // and that the long quiet part at the end is the server
  ])
    assert.ok(src.includes(key), `la pantalla de espera no dice ${key}`);
});

test("el reloj se ancla al comienzo de la fase, no al toque del botón", () => {
  const src = read(SCREEN);
  // Building and checking a season of eighteen thousand weighings is itself
  // tens of seconds. Counting those against the request's deadline would put a
  // number on the screen that is measuring something else.
  assert.match(src, /Date\.now\(\) - progress\.since/);
});

// ---- 4. No screen may print a raw translation key ------------------------

const SCREENS_DIR = join(HERE, "screens");
const screenFiles = () => readdirSync(SCREENS_DIR).filter((f) => f.endsWith(".tsx"));

/**
 * The keys no regex can see: the ones a screen BUILDS at run time.
 *
 * There are five of them across the product and every one is a template over a
 * closed set. A sweep that only reads `t("literal")` would declare the
 * dictionaries complete while `perf.rule.outlier` was missing in Portuguese —
 * so each family is expanded here from ITS OWN source of truth rather than
 * from a list somebody keeps up to date:
 *
 *   - `pay.kind.*`    from `LEDGER_KINDS`, the shared frozen tuple the ledger's
 *                     CHECK constraint is generated from;
 *   - `disc.*`        from the `DISCOUNTS` array in the screen that renders it;
 *   - `perf.rule.*`   from the `Anomaly["rule"]` union in `repository.ts`;
 *   - `import.phase.*` from `SeasonImportProgress["phase"]`.
 *
 * Reading them out of the source is the point. A sixth reason added to
 * `DISCOUNTS` next sprint appears here the moment it is written, which is what
 * a hand-kept list cannot do.
 */
function runtimeKeys(): string[] {
  const out: string[] = [];

  // The ledger kinds, from the tuple both ends share.
  for (const kind of LEDGER_KINDS) out.push(`pay.kind.${kind}`);

  // The deduction reasons, read off the array the buttons are rendered from.
  const discounts = read("screens/Adjust.tsx");
  const block = discounts.slice(discounts.indexOf("const DISCOUNTS = ["));
  const reasons = [...block.slice(0, block.indexOf("];")).matchAll(/key: "(\w+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(reasons.length >= 5, `DISCOUNTS ya no se puede leer: ${reasons.length} motivos`);
  for (const reason of reasons) out.push(`disc.${reason}`);

  // The anomaly rules, read off the union the repository declares.
  const repo = read("data/repository.ts");
  const union = /rule: ((?:"\w+"(?: \| )?)+);/.exec(repo);
  assert.ok(union, "el union de Anomaly['rule'] ya no se puede leer");
  const rules = [...union[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(rules.length >= 5, `solo se leyeron ${rules.length} reglas`);
  for (const rule of rules) out.push(`perf.rule.${rule}`);

  // The import's phases, from the union that produces them.
  const importer = read("sync/seasonImport.ts");
  const phases = /phase: ((?:"\w+"(?: \| )?)+);/.exec(importer);
  assert.ok(phases, "el union de SeasonImportProgress['phase'] ya no se puede leer");
  for (const m of phases[1].matchAll(/"(\w+)"/g)) out.push(`import.phase.${m[1]}`);

  return out;
}

/**
 * Every key every screen asks for, in all three dictionaries.
 *
 * `translate` falls back to Spanish and then to the raw key, so a missing
 * Portuguese string is not a crash — it is `pay.movedToWebCrew` printed on the
 * screen of somebody who needed the sentence. `flagOff.test.ts` pins the
 * eleven keys the flag-off build shows; this pins all of them, which is what
 * makes adding a screen safe, and it is the check that has to keep passing
 * with `LOCAL_SETTLEMENT` off.
 */
test("ninguna pantalla puede enseñar una clave de traducción en crudo", () => {
  const keys = new Set<string>(runtimeKeys());
  for (const file of screenFiles())
    for (const m of readFileSync(join(SCREENS_DIR, file), "utf8").matchAll(/\bt\(\s*"([\w.]+)"/g))
      keys.add(m[1]);

  assert.ok(keys.size > 200, `solo se encontraron ${keys.size} claves: el barrido no está mirando`);

  const missing: string[] = [];
  for (const lang of LANGS)
    for (const key of [...keys].sort())
      if (translate(lang, key) === key) missing.push(`${lang}: ${key}`);

  assert.deepEqual(missing, [], `claves sin traducir:\n${missing.join("\n")}`);
});

test("y toda clave armada en tiempo de ejecución está cubierta por el barrido", () => {
  // The sweep above is only honest while every `t(\`…\`)` in the product
  // belongs to a family `runtimeKeys` expands. A sixth one added elsewhere
  // would be invisible to it and would reach a screen as raw text — which is
  // precisely how `perf.rule.*` and `disc.*` went unchecked until now.
  const covered = new Set(runtimeKeys().map((k) => k.slice(0, k.lastIndexOf(".") + 1)));
  const uncovered: string[] = [];
  for (const file of screenFiles())
    for (const m of readFileSync(join(SCREENS_DIR, file), "utf8").matchAll(/\bt\(\s*`([^`]*)`/g)) {
      const prefix = m[1].slice(0, m[1].indexOf("${"));
      if (!covered.has(prefix)) uncovered.push(`${file}: ${m[1]}`);
    }

  assert.deepEqual(
    uncovered,
    [],
    "hay claves armadas en tiempo de ejecución que el barrido no puede ver",
  );
});
