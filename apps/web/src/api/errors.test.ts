/**
 * OCHO CÓDIGOS LLEGABAN A LA PANTALLA EN INGLÉS.
 *
 * Uno de ellos era `LAST_OWNER`: el que ve un dueño cuando intenta quitarse a
 * sí mismo. En medio de una consola en español, un código en mayúsculas y una
 * frase en inglés no dicen «esto no se puede»: dicen «usted rompió algo», que
 * es justo lo que este producto no puede permitirse decirle a alguien que ya
 * da por hecho que la culpa es suya.
 *
 * Traducirlos a mano fue la mitad del arreglo. Ésta es la otra: la tabla se
 * comprueba contra el contrato, así que el día que la API añada un código —y
 * lo hace cada sprint— la prueba lo nombra en vez de dejarlo salir a pantalla
 * en inglés hasta que alguien se tropiece con él.
 *
 * Se lee `schema.ts` con `fs` en vez de importar el tipo porque `ErrorCode` es
 * un tipo y no un valor: no existe en tiempo de ejecución, y una prueba que
 * sólo comprueba tipos no falla, deja de compilar en otro sitio.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ERROR_MESSAGES, ApiError, messageFor } from "./errors";

function contractCodes(): string[] {
  // Desde la raíz del proyecto: bajo jsdom `import.meta.url` es una URL http y
  // `fileURLToPath` la rechaza.
  const schema = readFileSync(resolve(process.cwd(), "src/api/schema.ts"), "utf8");
  const line = schema.match(/ErrorCode: ((?:"[A-Z_]+" \| )*"[A-Z_]+");/);
  if (!line) throw new Error("no se encontró ErrorCode en schema.ts");
  return line[1].split(" | ").map((s) => s.replace(/"/g, ""));
}

describe("la tabla de mensajes contra el contrato", () => {
  it("tiene una frase en español para cada código que la API puede enviar", () => {
    const missing = contractCodes().filter((c) => !(c in ERROR_MESSAGES));
    expect(missing).toEqual([]);
  });

  it("y ninguna de esas frases está vacía", () => {
    for (const code of contractCodes()) {
      expect(ERROR_MESSAGES[code].trim().length).toBeGreaterThan(10);
    }
  });

  /**
   * El que el evaluador nombró: un dueño quitándose a sí mismo. Y la frase
   * dice qué hacer, no sólo qué pasó — nombrar a otro dueño primero.
   */
  it("el dueño que se quita a sí mismo lee español, y lee qué hacer", () => {
    const e = new ApiError(409, {
      error: { code: "LAST_OWNER", message: "farm would be left with no owner" },
    });
    expect(messageFor(e)).toContain("sin dueño");
    expect(messageFor(e)).toContain("otro dueño");
    expect(messageFor(e)).not.toContain("owner");
  });

  /** Sin traducción, el texto del servidor se muestra en vez de tragarse. */
  it("un código desconocido enseña lo que dijo el servidor, no una pantalla muda", () => {
    const e = new ApiError(409, {
      error: { code: "SOMETHING_NEW", message: "algo pasó" },
    });
    expect(messageFor(e)).toBe("algo pasó");
  });
});
