/**
 * ── EL VOCABULARIO ───────────────────────────────────────────────────────
 *
 * Un término, un sitio donde se decide.
 *
 * Este fichero existe porque «parcela» estaba escrita a mano en treinta y siete
 * sitios y «lote» —la misma tierra— en otros tantos, incluido el primer campo
 * del formulario que crea una parcela. El producto se contradecía a sí mismo, y
 * arreglarlo era una cacería. Ahora es una línea.
 *
 * QUÉ ENTRA AQUÍ. Las palabras que nombran una COSA del oficio y que aparecen
 * en más de una pantalla: la tierra, la persona, la forma de pago, el estado de
 * una cifra, los tipos de asiento del libro. No entran las frases: una frase se
 * escribe donde se lee, y `features/harvest/text.ts` ya es el sitio de las
 * frases de cosecha.
 *
 * LA REGLA QUE MANDA SOBRE TODAS. **Un comprobante viejo y uno nuevo tienen que
 * leerse como el mismo documento.** Lo que se imprime —recibo de pago,
 * liquidación, planilla, en `features/documents/documents.ts`— cambia con
 * muchísimo más cuidado que lo que sólo se ve en pantalla: la pregunta no es
 * «¿es la mejor palabra?» sino «¿vale la pena que dos recibos del mismo año no
 * se parezcan?». Cada constante de aquí dice si sale en papel y qué se decidió.
 *
 * LO QUE NO SE TOCA, porque lo eligió alguien que sabe del oficio: liquidar,
 * jornal, cuadrilla, planilla, pesada, anticipo, bruto, bodega, lata, saldo a
 * favor. Están bien.
 *
 * Y hay una prueba —`vocab.test.ts`— que lee el código fuente y falla si
 * alguien vuelve a escribir a mano una de las palabras que este fichero jubiló.
 */
import type { LedgerKind, PayMode, TimeUnit } from "../api/types";

/* ------------------------------------------------------------------ */
/* 1. LA TIERRA — «lote», nunca «parcela»                              */
/* ------------------------------------------------------------------ */

/**
 * El teléfono dice «lote» en todas sus pantallas y en su recibo impreso, y no
 * conoce la palabra «parcela»: `grep -i parcela apps/mobile/src` no devuelve
 * nada. La consola decía «Parcelas» en el menú y «Nombre del lote» en el primer
 * campo del formulario que las crea.
 *
 * NO SALE EN PAPEL. Los tres documentos no nombran la tierra en ninguna
 * cabecera, columna ni firma, así que este cambio no le cuesta nada al archivo:
 * un recibo de 2026 y uno de 2027 siguen siendo idénticos. Por eso es el
 * primero de la lista.
 *
 * El identificador en el código sigue siendo `plot` —es la palabra del servidor
 * (`/v1/plots`, `plots.read`) y cambiarla sería otro sprint y ninguna mejora
 * para quien usa esto.
 */
export const LOTE = {
  one: "lote",
  many: "lotes",
  One: "Lote",
  Many: "Lotes",
  /** La ruta. `/parcelas` redirige aquí para no romper lo que esté guardado. */
  path: "/lotes",
} as const;

/* ------------------------------------------------------------------ */
/* 2. LA PERSONA — «empleado» en la consola                            */
/* ------------------------------------------------------------------ */

/**
 * LA CONSOLA DICE «EMPLEADO»; EL TELÉFONO DICE «RECOLECTOR». Los dos imprimen:
 * el papel de aquí firma «Firma del empleado» y el del teléfono «Firma del
 * recolector».
 *
 * Gana **empleado**, por dos razones y en ese orden:
 *
 *   1. Ya está impreso en los tres documentos de la consola —la línea de firma
 *      del recibo y de la liquidación, y la columna «Empleado» de la planilla.
 *      Cambiarlo hace que dos recibos del mismo año no se parezcan, que es
 *      exactamente lo que la regla prohíbe.
 *   2. Es el único de los dos que es cierto. La consola administra guadañadores,
 *      jornaleros y mayordomos que no recogen café ni un día del año, y
 *      llamarle «recolector» a un guadañador en su propio recibo es un error de
 *      hecho. El teléfono sólo ve pesadas, así que allí «recolector» es la
 *      palabra correcta y se queda.
 *
 * Y «recolector» se queda también en la consola donde de verdad significa
 * *quien recogió* —las columnas y los conteos del módulo de Cosecha—, porque
 * ahí nombra un papel en esa semana, no el registro de la persona. Ver
 * `RECOLECTOR`.
 */
export const EMPLEADO = {
  one: "empleado",
  many: "empleados",
  One: "Empleado",
  Many: "Empleados",
  path: "/empleados",
} as const;

/**
 * Quien recogió. NO es sinónimo de empleado: es lo que hizo esa semana.
 *
 * Sólo se usa en Cosecha, donde la fila de una tabla es «kilos que recogió esta
 * persona» y llamarla «empleado» perdería justo lo que la tabla mide.
 */
export const RECOLECTOR = {
  one: "recolector",
  many: "recolectores",
  One: "Recolector",
  Many: "Recolectores",
} as const;

/* ------------------------------------------------------------------ */
/* 3. CÓMO SE LE PAGA A LA GENTE                                       */
/* ------------------------------------------------------------------ */

/**
 * Los dos botones que deciden cómo se le paga a una persona se llamaban
 * «Unidad de trabajo» y «Unidad de tiempo», que son nombres de columna de base
 * de datos. Nadie en una finca dice «esta actividad se paga por unidad de
 * trabajo»: dice **a destajo**, **por kilo**, **al jornal**, **por contrato**.
 *
 * *Destajo* es la palabra con la que se paga la recolección de café en
 * Colombia y no aparecía ni una vez en el producto.
 *
 * NO SALE EN PAPEL: los documentos imprimen el nombre de la actividad y su
 * unidad («kg»), nunca la forma de pago. Cambio gratis para el archivo.
 */
export const PAY_MODE_LABEL: Record<PayMode, string> = {
  work_unit: "A destajo",
  time_unit: "Al jornal",
  contract: "Por contrato",
};

/** Lo mismo, con el ejemplo pegado, para el botón que hay que entender. */
export const PAY_MODE_CHOICE: Record<PayMode, string> = {
  work_unit: "A destajo · por kilo",
  time_unit: "Al jornal · por día",
  contract: "Por contrato",
};

/** Una frase, para donde hace falta explicarlo dentro de un texto. */
export const PAY_MODE_SENTENCE: Record<PayMode, string> = {
  work_unit: "se paga a destajo: por lo que la persona haga",
  time_unit: "se paga al jornal: por el tiempo que la persona esté",
  contract: "se paga por contrato: un total acordado de antemano",
};

/** «jornales», «semanas»… lo que se cuenta cuando se paga al tiempo. */
export const TIME_UNIT_LABEL: Record<TimeUnit, string> = {
  jornal: "Jornal (día)",
  semanal: "Semanal",
  quincenal: "Quincenal",
  mensual: "Mensual",
  custom: "Otra",
};

/* ------------------------------------------------------------------ */
/* 4. LA CIFRA QUE TODAVÍA PUEDE MOVERSE — «provisional»               */
/* ------------------------------------------------------------------ */

/**
 * Un mismo estado tenía tres nombres, uno por pantalla: **provisional** en el
 * papel, **estimado** en el tablero y en los perfiles, y **precio de la
 * semana** en Actividades y en el detalle de una liquidación. Son lo mismo: la
 * plata todavía no está decidida porque el precio del kilo de esa semana no se
 * ha fijado.
 *
 * GANA «PROVISIONAL», Y GANA PORQUE YA ESTÁ EN EL PAPEL: el bloque ámbar de un
 * recibo dice PROVISIONAL en letra grande y `docs/sincronizacion.md` lo pide
 * así. Elegir cualquier otro habría obligado a cambiar los tres documentos.
 * Además es la palabra que el teléfono ya usa para su saldo sin confirmar
 * (`pay.provisional`), así que las dos mitades del producto quedan diciendo lo
 * mismo sin tocar una línea impresa.
 *
 * «El precio de la semana» sigue existiendo — pero como el nombre del PRECIO,
 * que es una cosa real que el dueño fija los lunes, no como el nombre del
 * estado de una cifra.
 */
export const PROVISIONAL = "provisional";

/** La nota que va pegada a una cifra que todavía puede moverse. */
export const PROVISIONAL_NOTE = "provisional · al precio de la semana";

/** Lo mismo dentro de una frase: «… incluye provisional al precio de la semana». */
export const PROVISIONAL_INCLUDES = "incluye provisional, al precio de la semana";

/** Por qué puede moverse. Va de tooltip o de pie, nunca sola. */
export const PROVISIONAL_WHY =
  "Provisional quiere decir que el precio del kilo de esa semana todavía no está " +
  "fijado. Al fijarlo, la cifra se congela y deja de moverse.";

/* ------------------------------------------------------------------ */
/* 5. EL LIBRO — sin contaduría ni programación en la pantalla         */
/* ------------------------------------------------------------------ */

/**
 * `devengo` y `reverso` son los nombres de dos `kind` del libro. El primero es
 * de contaduría, el segundo de programación, y ninguno de los dos lo dice nadie
 * en una finca. En pantalla pasan a ser **ganado** y **corrección** — «lo que
 * se ganó» y «se corrigió», sustantivados para que la columna «Tipo» no mezcle
 * frases con sustantivos.
 *
 * `deduccion` pasa a **descuento**, que es como lo dice el teléfono y como lo
 * dice la finca.
 *
 * EL PAPEL NO CAMBIA, Y ES UNA DECISIÓN, NO UN OLVIDO. `devengo` y `reverso`
 * salen impresos en un solo sitio: el bloque rojo de una liquidación ANULADA,
 * cuyo trabajo entero es cuadrarse contra el libro tres semanas después. Ahí
 * las palabras del libro son las correctas, y una liquidación anulada de 2026 y
 * otra de 2027 tienen que ser el mismo documento. Lo que sí se hizo fue atar
 * las dos mitades: la pantalla que anula dice, en la misma frase, que a eso el
 * libro y el papel lo llaman «reverso», para que quien tenga el papel en la
 * mano encuentre la palabra. Ninguna cabecera, columna, total ni línea de firma
 * se movió.
 */
export const LEDGER_KIND_LABEL: Record<LedgerKind, string> = {
  devengo: "ganado",
  pago: "pago",
  anticipo: "anticipo",
  deduccion: "descuento",
  ajuste: "ajuste",
  reverso: "corrección",
};

/** El asiento que deshace otro, dicho entero y con su nombre de papel al lado. */
export const CORRECCION_GLOSS =
  "una corrección: un asiento contrario que deshace el anterior y deja ver qué " +
  "pasó y cuándo. En el libro y en el papel se llama «reverso».";

/**
 * Lo que se ganó y ya quedó escrito, frente a lo que se ganó y todavía no.
 *
 * La frase que sustituye a «todavía no es un devengo». Dice lo mismo sin pedir
 * que el lector sepa contaduría.
 */
export const NOT_YET_EARNED =
  "trabajo hecho que todavía no está liquidado, así que aún no aparece en el saldo";

/* ------------------------------------------------------------------ */
/* 6. LA BODEGA — entradas y salidas, no un extracto bancario          */
/* ------------------------------------------------------------------ */

/**
 * «Movimientos» es la palabra de un extracto de banco. En una bodega lo que
 * pasa son **entradas y salidas**, y así se dice.
 *
 * NO SALE EN PAPEL: ningún documento impreso habla de la bodega.
 *
 * «Saldo a favor» —que sí suena a banco— se queda: es palabra de finca, el
 * teléfono la imprime en su recibo y significa exactamente lo que dice.
 */
export const STOCK_MOVE = {
  one: "entrada o salida",
  many: "entradas y salidas",
  One: "Entrada o salida",
  Many: "Entradas y salidas",
  /** Para las frases: «la suma de las entradas y salidas». */
  ofThem: "las entradas y salidas",
} as const;

/* ------------------------------------------------------------------ */
/* 7. LO LIQUIDADO — «bruto» se queda, «(vigentes)» no                 */
/* ------------------------------------------------------------------ */

/**
 * «Bruto liquidado» está impreso en la liquidación y en la planilla, y «bruto»
 * es palabra de finca. Se queda tal cual.
 *
 * Lo que no era palabra de nadie es el paréntesis: «(vigentes)» es un estado de
 * fila de base de datos. Lo que quiere decir es que las liquidaciones anuladas
 * no se cuentan, y eso se puede decir así.
 */
export const GROSS_SETTLED = "Bruto liquidado";
export const GROSS_SETTLED_LIVE = "Bruto liquidado (sin las anuladas)";
export const GROSS_SETTLED_LIVE_FILTERED = "Bruto liquidado (sin las anuladas, filtrado)";
