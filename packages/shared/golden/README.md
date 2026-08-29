# Casos de oro

Fixtures JSON con entradas y **los números exactos que deben salir**. Existen
para una sola cosa: que el servidor en Go no calcule el dinero distinto al
teléfono.

No son pruebas del móvil. Son el contrato de cálculo, escrito en un formato que
las dos suites recorren. Si el móvil y el servidor pasan los mismos ficheros,
un recolector cobra lo mismo se haya pesado desde donde se haya pesado.

- `cases/*.json` — los casos, en orden de fichero.
- `runner.ts` — el recorredor de TypeScript.
- `golden.test.ts` — la suite `node:test` que los ejecuta.

El recorredor **no reimplementa nada**: importa `BASE_SCHEMA`,
`PAYMENTS_SCHEMA`, `PENDING_SQL`, `BALANCE_SQL`, `WEEK_OF` y `DAY_OF` de
`apps/mobile/src/schema.ts` y los ejecuta bajo `node:sqlite`, igual que las
suites que ya existían. Lo único retecleado es la *secuencia de escrituras* de
una liquidación, porque `apps/mobile/src/db.ts` abre `expo-sqlite` a nivel de
módulo y no se puede importar fuera de un teléfono
(`docs/diagramas/movil.md` §9.2). Esa secuencia sigue a `Payments.settle`,
`pay`, `advance`, `deduct`, `adjust`, `reverse` y `voidSettlement` sentencia por
sentencia.

---

## Cómo se lee un caso

```jsonc
{
  "id": "saldo-a-favor",        // único; el nombre del fichero lo prefija con un número de orden
  "title": "…",                 // una línea, para el informe de la suite
  "why": "…",                   // POR QUÉ existe: qué diverge si se reescribe de memoria
  "timezone": "America/Bogota", // la zona de la finca (ver "Tiempo" abajo)
  "generalRateCents": 80000,    // precio por unidad, en centavos enteros
  "weeklyRateCents": {          // opcional: overrides por semana (lunes -> centavos)
    "2026-08-24": 95000
  },
  "people": [{ "id": 1, "name": "Ana", "lastName": "Rodríguez" }],
  "crops":  [{ "id": 1, "name": "Lote 1" }],
  "events": [ /* … se aplican EN ORDEN … */ ],
  "expect": { /* … lo que la base debe contener al final … */ }
}
```

### Reglas del formato, sin ambigüedad

1. **El dinero es siempre un entero de centavos.** Todo campo que termine en
   `Cents` es un entero con signo que cabe en `int64`. Nunca hay un decimal en
   un importe. La suite lo verifica sobre el corpus entero, así que un fixture
   con `4200000.5` falla antes de comparar nada.
2. **Las fechas de negocio son `YYYY-MM-DD` a secas**, sin hora y sin zona.
   Son días del calendario de la finca, no instantes.
3. **La única excepción es `pickup.at`**: una hora de reloj de pared local,
   `YYYY-MM-DDTHH:MM` sin desfase, porque el desfase es el de la finca y no el
   del fichero. Ver "Tiempo".
4. **`quantity` es lo único que puede llevar decimales**: es una medida (kilos
   en una báscula, canastas, número de jornales), un `float64` IEEE-754. El
   literal decimal del JSON se decodifica al mismo `double` en Go
   (`encoding/json`) y en JavaScript, así que no hay ambigüedad.
5. **Las claves que aparecen en `expect` se comprueban; las que faltan, no.**
   Un caso afirma lo que dice y nada más.
6. **Los ids son deterministas.** `people[].id`, `crops[].id` y `pickup.id`
   vienen dados. Los de `settlements` y `ledger` los asigna el `AUTOINCREMENT`
   en orden de escritura empezando en 1 — por eso un evento `void` o `reverse`
   puede apuntar a ellos por número.

### Eventos

| `op` | Campos | Qué hace |
|---|---|---|
| `pickup` | `id`, `personId`, `cropId`, `quantity`, `at` | Registra una pesada. `at` es hora local de pared. |
| `settle` | `personId`, `from`, `to`, `on`, `note?` | Congela en una liquidación toda pesada no reclamada cuyo **día local** esté entre `from` y `to`, y asienta el `devengo`. |
| `pay` | `personId`, `amountCents`, `on`, `method?` | Efectivo entregado. El importe llega **positivo**. |
| `advance` | `personId`, `amountCents`, `on`, `note?` | Anticipo. Positivo. |
| `deduct` | `personId`, `amountCents`, `on`, `note` | Descuento (comida, herramienta…). Positivo. |
| `adjust` | `personId`, `signedCents`, `on`, `note` | Corrección; **este sí llega con signo**. |
| `void` | `settlementId`, `on`, `note?` | Anula la liquidación y libera sus pesadas. |
| `reverse` | `ledgerId`, `on`, `note` | Cancela un movimiento del diario con su opuesto. |
| `checkpoint` | `label` | No escribe. Fotografía los saldos en ese punto de la historia. |

`on` es "el día que la finca cree que es" cuando ocurre la operación. Está en el
fichero y no se toma del reloj, porque un caso tiene que dar el mismo resultado
hoy y dentro de tres años. En el servidor, `on` es *hoy* en la zona de la finca.

### Lo que se compara

| Clave de `expect` | Contenido |
|---|---|
| `pickups` | `{ id, localDay, week }` por pesada, ordenado por id. El día local y el lunes de su semana. |
| `settlements` | `{ id, personId, periodStart, periodEnd, grossCents, status, items[] }`, ordenado por id. Cada `item`: `{ pickupId, week, quantity, costPerUnitCents, amountCents, voided }`, en el orden en que se escribieron (que es el de la fecha de la pesada). |
| `ledger` | Todo el diario ordenado por id: `{ id, personId, kind, amountCents, date, settlementId, reversesId }`. |
| `balances` | Por trabajador: `{ personId, earnedCents, paidCents, deductedCents, balanceCents, lastMovementAt }`. |
| `checkpoints` | `{ label, balances[] }` por cada `checkpoint`, en orden. |

---

## Las reglas que estos casos fijan

**Dinero.** `amountCents = round(quantity × rateCents)`, redondeando **medio
hacia arriba** (medio lejos del cero; las cantidades aquí nunca son negativas).
En Go, `int64(math.Round(quantity * float64(rateCents)))`. **No** es redondeo
bancario: `2.5 × 8333 = 20832.5` da `20833`, no `20832`. Y se redondea **por
línea**, sumando después enteros — redondear la suma da otro total.

**Signos.** Positivo = la finca le debe al trabajador. `devengo` > 0; `pago`,
`anticipo` y `deduccion` < 0; `ajuste` y `reverso` libres, nunca cero. Los
métodos reciben magnitudes positivas y el signo lo pone la capa de datos. Un
`reverso` se clasifica en el desglose **por su signo**, no por el tipo del
movimiento que cancela.

**Saldo.** `balanceCents` es `SUM(amountCents)` a secas. Nunca se guarda: se
deriva. `earnedCents` / `paidCents` / `deductedCents` son desglose para la
pantalla, y `ajuste` no aparece en ninguno de los tres aunque sí en el saldo.

**Tiempo.** La semana es la **fecha ISO de su lunes** (`2026-08-24`), nunca una
etiqueta `%Y-W%W`. El día de negocio de una pesada es su día **en la zona de la
finca**, no en UTC: se convierte el instante a la zona y *después* se saca el
día. Derivar la semana directamente del instante UTC mete las tardes de domingo
en la semana siguiente.

> Para un motor en Go: `pickup.at` se interpreta en `timezone` del caso —
> `time.ParseInLocation("2006-01-02T15:04", at, loc)` — y se guarda como
> instante UTC. En `America/Bogota` (UTC−5), `2026-08-30T19:30` es
> `2026-08-31T00:30Z`: **lunes en UTC, domingo en la finca.** Ese es
> exactamente el caso 04.
>
> El recorredor de TypeScript construye el instante desde las partes de reloj de
> pared con la zona del proceso, así que la suite da el mismo resultado en
> cualquier máquina: lo que el fichero afirma es la hora de pared, y `'localtime'`
> de SQLite deshace la conversión con el mismo desfase.

**El candado.** Una pesada pertenece como mucho a **una** liquidación viva
(`UNIQUE(pickupId) WHERE voidedAt IS NULL`). Anular no borra: marca las líneas
con `voidedAt` — que es lo que libera la pesada — y asienta un `reverso` del
`devengo`. En el modelo generalizado del servidor la columna se llama
`payable_id`, pero el índice parcial es el mismo.

---

## Los casos

| # | id | Qué fija |
|---|---|---|
| 01 | `saldo-a-favor` | Cobrar menos de lo devengado deja el resto a favor del trabajador. |
| 02 | `anticipo-mayor-que-la-semana` | Un anticipo mayor que la semana se amortiza contra varias, con el saldo comprobado semana a semana. |
| 03 | `semana-a-caballo-de-dos-anios` | La semana del 29 de diciembre es **una**, con **un** precio, a los dos lados del año. |
| 04 | `domingo-por-la-tarde-en-colombia` | Una pesada del domingo 19:30 en Colombia —lunes en UTC— pertenece a la semana que se paga, y a la tarifa de esa semana. Este bug ya ocurrió. |
| 05 | `liquidacion-anulada-y-reliquidada` | Anular libera la pesada, deja al trabajador debiendo lo cobrado, y la pesada se vuelve a liquidar exactamente una vez. |
| 06 | `redondeo-medio-centavo` | Productos que caen justo en medio centavo: medio hacia arriba, y redondeo por línea. |
| 07 | `pago-mayor-al-saldo` | Un pago mayor al saldo deja saldo negativo y se comporta como anticipo. El saldo no se recorta. |
| 08 | `deduccion-reverso-y-ajuste` | La tabla de signos: deducción aparte, reverso clasificado por signo, ajuste fuera del desglose. |
| 09 | `pesada-tardia-de-semana-ya-liquidada` | Una pesada anotada tarde rueda a la liquidación siguiente, al precio de **su** semana. |

## Añadir un caso

1. Crear `cases/NN-lo-que-sea.json` con un `id` nuevo y un `why` que diga qué
   se rompe si alguien lo reescribe de memoria. El `why` sale en el mensaje de
   fallo: es lo que leerá quien lo rompa.
2. `npm test --workspace @bascula/shared`.
3. Si el caso pinta un comportamiento que el móvil **no** tiene hoy, no es un
   caso de oro: es una propuesta de cambio. Estos ficheros describen lo que la
   finca ya está haciendo con dinero real.

Añadir un caso obliga al servidor a pasarlo. Es deliberado: para eso están.
