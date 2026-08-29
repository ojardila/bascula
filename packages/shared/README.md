# @bascula/shared

Lo que **no puede divergir** entre el teléfono, la API en Go y la web.

El criterio es el de `docs/arquitectura-api.md` §7 y es deliberadamente
estrecho: aquí sólo entra lo que, si se escribe dos veces y se escribe distinto,
**cuesta dinero**. Todo lo demás se queda donde se usa.

```
src/enums.ts    LedgerKind · PayMethod · Role · SettlementStatus · PayMode · ActivityCategory
src/money.ts    toCents · fromCents · amountCents(qty, rate) · la tabla de signos por kind
src/time.ts     mondayOf · parseDay · addDays · weekNumber · localDayOf · weekOf
src/format.ts   formatMoney · formatNumber · formatWeekRange · formatDay
src/harvest.ts  readHarvest — la lectura de la curva de cosecha
golden/         los casos de oro. Ver golden/README.md
```

## Por qué cada cosa está aquí

**Los enums** son conjuntos cerrados que viajan por el cable. `deduccion`
escrito con tilde en un lado es un descuento que deja de contarse.
`src/enums.test.ts` los compara contra los `CHECK` reales de
`apps/mobile/src/schema.ts`: añadir un `kind` en un sitio y no en el otro falla
en la suite, no en una finca un domingo por la tarde.

**El dinero** es una sola multiplicación —`round(quantity × rateCents)`— y una
tabla de seis signos, y las dos son exactamente donde dos lenguajes divergen en
silencio: redondeo al par en vez de medio lejos del cero, redondear el total en
vez de cada línea, o —la tercera, que costó cuatro centavos por liquidación—
hacer la multiplicación en coma flotante, donde `1,005 × 7500` nunca llega al
medio que hay que redondear hacia arriba. `amountCents` multiplica los dígitos
decimales de la cantidad en `BigInt`, como `big.Rat` en Go y `numeric` en
Postgres. Ver `golden/README.md`.

**El tiempo** decide qué precio se aplica. La semana es la fecha del lunes,
nunca `%Y-W%W`; el día de negocio es el día **en la zona de la finca**, no en
UTC. Las dos reglas ya se rompieron una vez cada una.

**Los formateadores** vienen del móvil sin tocar una línea. Están aquí porque
un recibo impreso desde el servidor y uno impreso desde el teléfono tienen que
leerse idénticos: el trabajador los compara. Y porque el formateo a mano —en vez
de `Intl`— es la razón de que `$1.471.070` no salga como `$1,471,070` en un
Android con el locale en `en-US`.

## Qué NO está aquí, a propósito

- **`db.ts` y `schema.ts` se quedan en el móvil.** Son SQLite y son del
  teléfono; el servidor lleva Postgres. Lo que cruza no es el SQL, es su
  **comportamiento**, y eso lo fijan los casos de oro.
- **`csv.ts`, `strings.ts`, `receiptHtml.ts`, `cropTypes.ts`.** Son puros y
  portables, pero si divergen no cuesta dinero: cuesta una coma mal puesta.
  Cuando la web necesite exportar, `csv.ts` es el primer candidato a subir.
- **DTOs y clientes de API.** `openapi.yaml` es la fuente de verdad y se
  generan (`oapi-codegen` para Go, `openapi-typescript` para web y móvil). Un
  tipo escrito a mano aquí competiría con el generado.

## Cómo se consume

Sin paso de compilación y sin dependencias: Node 26 ejecuta TypeScript
directamente y los tests son `node:test` + `node:sqlite`.

El móvil importa por **ruta relativa** (`../../../packages/shared/src/…`), no
por nombre de paquete. Es a propósito: Metro ya vigila la raíz del monorepo
—`serverRoot` es la raíz, no `apps/mobile`—, así que una ruta relativa resuelve
sin `metro.config.js`, sin enlace en `node_modules` y sin tocar el lockfile. El
teléfono está en producción en plena cosecha; esta era la opción con menos
piezas móviles. Cuando la web y la API entren, migrar a `@bascula/shared` es un
`sed`.

```bash
npm test       --workspace @bascula/shared   # 48 pruebas
npm run typecheck --workspace @bascula/shared
```

`npm test` en la raíz ejecuta el móvil **y** este paquete (109 pruebas). Esa
suma vive hoy en el script de `apps/mobile/package.json`; lo limpio es una línea
en la raíz —`"test": "npm test --workspaces --if-present"`— pero eso es cambio
del `package.json` raíz y se deja decidido fuera.

## Una nota para el backend

`ActivityCategory` tiene **tres** valores aquí (`siembra`, `mantenimiento`,
`cosecha`), siguiendo `docs/arquitectura-api.md`. `docs/modelo-datos.md`
declara un cuarto, `otra`. Los dos documentos no coinciden y nadie lo ha
decidido: está señalado en `src/enums.ts` en vez de resuelto a ojo. Falta
también `StockReason`, que `arquitectura-api.md` §7 menciona pero para el que
no hay todavía nada que calcular.
