#!/usr/bin/env node
/**
 * Fail the build when `src/api/schema.ts` is behind `services/api/openapi.yaml`.
 *
 * WHY A GATE AND NOT A GENERATE STEP.
 *
 * The obvious thing is to regenerate on every build and carry on. It is the
 * wrong thing, because it makes a change to the contract INVISIBLE: the
 * generated file changes under the build, the assertions in
 * `src/api/contract.assert.ts` start failing, and the person looking at the
 * error has no idea that the API grew a field ten minutes ago. Sprint 1's most
 * expensive week was spent exactly there — the two halves disagreeing, quietly,
 * with green tests on both sides.
 *
 * So: the generated file is committed, and this refuses to build when it is
 * stale, naming the command that fixes it. Regenerating is a deliberate act
 * with a reviewable diff, and the diff IS the notice that the contract moved.
 *
 * It also refuses when the spec is MISSING, rather than skipping. A check that
 * quietly passes when it cannot find what it checks is a check that will pass
 * forever the first time somebody moves a directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../../services/api/openapi.yaml");
const COMMITTED = resolve(here, "../src/api/schema.ts");

const box = (lines) =>
  ["", "┌" + "─".repeat(76), ...lines.map((l) => "│  " + l), "└" + "─".repeat(76), ""].join("\n");

function fail(lines) {
  console.error(box(lines));
  process.exit(1);
}

let spec;
try {
  spec = readFileSync(SPEC, "utf8");
} catch {
  fail([
    "NO ENCONTRAMOS EL CONTRATO",
    "",
    `Se esperaba: ${SPEC}`,
    "",
    "Los tipos de la web se generan de ese archivo. Sin él no se puede",
    "comprobar nada, y una comprobación que pasa sin comprobar es peor",
    "que no tenerla.",
  ]);
}
if (!spec.includes("openapi:")) {
  fail([`${SPEC} no parece un documento OpenAPI.`]);
}

let committed;
try {
  committed = readFileSync(COMMITTED, "utf8");
} catch {
  fail([
    "FALTAN LOS TIPOS GENERADOS",
    "",
    `Se esperaba: ${COMMITTED}`,
    "",
    "Genérelos con:    npm run types:api",
  ]);
}

/**
 * The generator lives in `apps/web/node_modules` when the app was installed
 * the way its README says (`npm install --prefix apps/web --no-workspaces`),
 * and in the repository root when somebody installed from there. Both are
 * real, so both are looked for, and NOT finding it is a failure rather than a
 * skip — see the note at the top.
 */
const cli = [
  resolve(here, "../node_modules/openapi-typescript/bin/cli.js"),
  resolve(here, "../../../node_modules/openapi-typescript/bin/cli.js"),
].find((p) => existsSync(p));

if (!cli) {
  fail([
    "FALTA openapi-typescript",
    "",
    "Instale las dependencias de la web:",
    "",
    "    npm install --prefix apps/web --no-workspaces",
  ]);
}

const dir = mkdtempSync(join(tmpdir(), "bascula-openapi-"));
const fresh = join(dir, "schema.ts");
try {
  execFileSync(process.execPath, [cli, SPEC, "-o", fresh], { stdio: "pipe" });
  const generated = readFileSync(fresh, "utf8");
  if (generated !== committed) {
    fail([
      "LOS TIPOS GENERADOS ESTÁN DESACTUALIZADOS",
      "",
      "services/api/openapi.yaml cambió y src/api/schema.ts no.",
      "",
      "Regénerelos y revise el diff — ese diff es el aviso de que el",
      "contrato se movió:",
      "",
      "    npm run types:api",
      "",
      "Si al hacerlo falla la compilación en src/api/contract.assert.ts,",
      "eso es exactamente lo que tiene que pasar: dice qué campo cambió",
      "y en qué tipo de src/api/wire.ts hay que reflejarlo.",
    ]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("openapi: src/api/schema.ts está al día con services/api/openapi.yaml");
