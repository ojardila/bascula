/**
 * LA PRUEBA QUE IMPIDE QUE EL VOCABULARIO VUELVA A DIVERGIR.
 *
 * `vocab.ts` sirve de poco si mañana alguien escribe «Parcelas» a mano en una
 * pantalla nueva: en tres sprints estamos otra vez con dos palabras para la
 * misma tierra y una cacería por treinta y siete ficheros. Así que esta prueba
 * LEE EL CÓDIGO FUENTE, le quita los comentarios y falla si encuentra una de
 * las palabras jubiladas donde se puede leer.
 *
 * POR QUÉ LEER FICHEROS Y NO RENDERIZAR PANTALLAS. Una prueba de render sólo ve
 * las pantallas que alguien se acordó de meter en ella, y el fallo que hay que
 * evitar es justamente el de la pantalla nueva que nadie añadió a la lista.
 * Esto ve todo lo que hay en `src/`, incluido lo que se escriba mañana.
 *
 * SE QUITAN LOS COMENTARIOS a propósito: este fichero y varios más EXPLICAN por
 * qué «parcela» se jubiló, y una prueba que prohibiera contar la historia
 * obligaría a borrar la razón del cambio junto con el cambio.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMPLEADO, GROSS_SETTLED, LEDGER_KIND_LABEL, LOTE, PAY_MODE_LABEL, PROVISIONAL,
  RECOLECTOR,
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
 * Quita comentarios sin romper las cadenas.
 *
 * Un `replace` con una expresión regular se come la barra doble de
 * `"https://…"` y, al revés, da por cerrado un comentario que en realidad está
 * dentro de una plantilla. Así que esto recorre el texto carácter a carácter
 * llevando la cuenta de dónde está. Es la única forma de que la prueba no
 * mienta en ninguna de las dos direcciones.
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
      // Se conservan los saltos de línea para que el número de línea del
      // mensaje de error siga siendo el del fichero de verdad.
      if (c === "\n") out += c;
      i++; continue;
    }
    // Dentro de una cadena. `\` escapa lo que venga.
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === state) state = "code";
    out += c; i++;
  }
  return out;
}

interface Hit { file: string; line: number; text: string }

/** Cada acierto de `pattern` en el código (sin comentarios) de `files`. */
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

/** Todo lo que una persona puede acabar leyendo: pantallas y sus ayudantes. */
const PRODUCT = ALL.filter(
  (f) =>
    !isTest(f) &&
    !f.endsWith(join(SRC, "lib", "vocab.ts")) &&
    !under("mocks")(f) &&
    !under("test")(f),
);

/** Sólo las pantallas. Aquí no cabe ni una palabra de contaduría. */
const SCREENS = PRODUCT.filter((f) => f.endsWith(".tsx"));

describe("la tierra se llama «lote», en un solo sitio", () => {
  it("nadie escribe «parcela» a mano en el producto", () => {
    // El único fichero que puede nombrarla es el que la jubila, y está fuera
    // de la lista. `App.tsx` la nombra sólo para redirigirla, y eso lo
    // comprueba la prueba de abajo. Si esto falla: importe `LOTE` de
    // `lib/vocab`.
    const offenders = hits(PRODUCT, /parcela/i).filter((h) => !h.file.endsWith("App.tsx"));
    expect(show(offenders)).toBe("");
  });

  it("y en `App.tsx` sólo sobrevive para redirigir el enlace viejo", () => {
    const inApp = hits(PRODUCT.filter((f) => f.endsWith("App.tsx")), /parcela/i);
    expect(inApp.length).toBeGreaterThan(0);
    for (const h of inApp) expect(h.text).toMatch(/Navigate|Redirect|replace\(/);
  });

  it("ni la ruta vieja, salvo la redirección que no rompe lo guardado", () => {
    const offenders = hits(PRODUCT, /["'`]\/parcelas/).filter(
      (h) => !h.file.endsWith("App.tsx"),
    );
    expect(show(offenders)).toBe("");
  });

  it("y `LOTE` dice lo que dice el teléfono", () => {
    expect(LOTE.one).toBe("lote");
    expect(LOTE.path).toBe("/lotes");
  });
});

describe("cómo se le paga a la gente se dice en el idioma del oficio", () => {
  it("no queda ni una «unidad de trabajo» ni una «unidad de tiempo»", () => {
    expect(show(hits(PRODUCT, /unidad(es)? de (trabajo|tiempo)/i))).toBe("");
  });

  it("y «destajo» —como se paga el café— existe", () => {
    expect(PAY_MODE_LABEL.work_unit).toMatch(/destajo/i);
    expect(PAY_MODE_LABEL.time_unit).toMatch(/jornal/i);
    expect(PAY_MODE_LABEL.contract).toMatch(/contrato/i);
  });
});

describe("una cifra que puede moverse se llama «provisional» y nada más", () => {
  it("«estimado» no sobrevive en ninguna pantalla", () => {
    expect(show(hits(SCREENS, /\bestimad[oa]s?\b/i))).toBe("");
  });

  it("y el papel ya la llamaba así, que es por lo que ganó", () => {
    expect(PROVISIONAL).toBe("provisional");
    const paper = readFileSync(join(SRC, "features/documents/documents.ts"), "utf8");
    expect(paper).toContain("PROVISIONAL");
  });
});

describe("el libro no le habla al caficultor en contaduría", () => {
  it("«devengo» y «reverso» no aparecen en ninguna pantalla", () => {
    expect(show(hits(SCREENS, /\b(devengos?|reversos?)\b/i))).toBe("");
  });

  it("los tipos de asiento están dichos en palabras de finca", () => {
    expect(LEDGER_KIND_LABEL.devengo).toBe("ganado");
    expect(LEDGER_KIND_LABEL.reverso).toBe("corrección");
    expect(LEDGER_KIND_LABEL.deduccion).toBe("descuento");
  });
});

describe("la bodega no es un extracto bancario", () => {
  it("en Inventario no quedan «movimientos»", () => {
    const inventory = PRODUCT.filter(under("features/inventory"));
    expect(inventory.length).toBeGreaterThan(0);
    expect(show(hits(inventory, /movimientos?/i))).toBe("");
  });

  it("pero «saldo a favor» y «bruto» se quedan: son palabras de finca", () => {
    expect(GROSS_SETTLED).toBe("Bruto liquidado");
    expect(EMPLEADO.One).toBe("Empleado");
  });
});

/**
 * LAS DOS PALABRAS PARA LA MISMA PERSONA, Y POR QUÉ GANÓ «EMPLEADO».
 *
 * La consola dice «empleado» y el teléfono «recolector», y los dos lo
 * imprimen. Gana el de la consola en la consola porque ya está en su papel —la
 * línea de firma y la columna de la planilla— y porque la consola administra
 * gente que no recoge café ni un día. Y «recolector» se queda en Cosecha, que
 * es donde de verdad significa *quien recogió*.
 */
describe("la persona se llama «empleado», y «recolector» sólo donde eso es lo que es", () => {
  it("Cosecha sigue diciendo recolector: ahí es un papel, no un registro", () => {
    expect(RECOLECTOR.Many).toBe("Recolectores");
    const harvest = PRODUCT.filter(under("features/harvest"));
    expect(hits(harvest, /RECOLECTOR\./).length).toBeGreaterThan(0);
  });

  it("y fuera de Cosecha nadie llama recolector a un empleado", () => {
    const elsewhere = SCREENS.filter((f) => !under("features/harvest")(f));
    expect(show(hits(elsewhere, /recolector/i))).toBe("");
  });
});

/**
 * EL PAPEL, PROTEGIDO POR SU PROPIA PRUEBA.
 *
 * Lo de arriba impide que la pantalla vuelva a hablar en contaduría. Esto
 * impide lo contrario: que un sprint de vocabulario le cambie a alguien las
 * palabras del comprobante que ya firmó. Si una de estas cadenas hay que
 * moverla, que sea una decisión con esta prueba delante y no un efecto
 * colateral de un `sed`.
 */
describe("lo que está impreso no se mueve por un sprint de palabras", () => {
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
  ])("«%s» sigue en el papel", (word) => {
    expect(paper).toContain(word);
  });

  it("y el bloque de una liquidación anulada conserva las palabras del libro", () => {
    // Es el ÚNICO sitio impreso donde salen, y sale para cuadrarse contra el
    // libro tres semanas después. Ver la nota de `LEDGER_KIND_LABEL`.
    expect(paper).toContain("devengo");
    expect(paper).toContain("reverso");
  });
});
