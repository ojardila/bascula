# Báscula — Sincronización móvil ↔ servidor

Especificación de entrega. Está escrita para que dos parejas la implementen sin
volver a preguntar: cada sección dice **qué se hace**, no **qué opciones hay**.
Donde hay una opción abierta, está en §10 y es del dueño.

El sistema del que habla ya existe y está en producción:

- El móvil corre en una finca, en plena cosecha, sobre SQLite `user_version = 5`,
  con claves primarias `INTEGER PRIMARY KEY AUTOINCREMENT`.
- El servidor tiene 66 rutas, Postgres con RLS, UUIDv7 en todas las tablas, y el
  candado anti doble pago en `ux_items_payable_live`.
- La decisión 3 del dueño puso a la web a registrar labores **ya**. Las dos
  verdades existen desde hoy, y hoy pagar desde los dos lados paga dos veces.

Nada de lo que sigue puede perder ni duplicar una pesada, una liquidación o un
pago que ya existe en el teléfono de esa finca.

---

## 0. Lo que este documento cierra, y con qué choca

### 0.1 Las cinco decisiones

1. **El servidor es dueño del candado. El teléfono no liquida sin haber
   sincronizado.** El efectivo en campo sin señal se registra como `anticipo`,
   que no necesita candado porque no reclama ninguna pesada. §6.
2. **El teléfono no cambia sus claves primarias.** Añade una columna `uuid` a
   cada tabla, la rellena hacia atrás, y sincroniza por UUID. Los enteros se
   quedan para los joins locales. §1.
3. **El mecanismo es un feed de cambios con secuencia por finca**, no un
   push/pull con marca de agua por tabla. El teléfono lleva un solo número. §3.
4. **La dirección se decide tabla por tabla y no es simétrica.** Precios y
   parcelas son de lectura en el teléfono; pesadas y movimientos de dinero son
   de escritura; saldos y reportes no viajan jamás. §2.
5. **Ningún conflicto se resuelve en silencio.** O lo resuelve una regla
   escrita aquí, o termina delante de una persona con nombre, fecha e importe. §5, §7.

### 0.2 Dónde choca con lo ya escrito

| Documento | Lo que dice | Lo que este documento decide |
|---|---|---|
| `sync-and-roles.md` | «una liquidación lleva el conjunto de pesadas que reclama, y el servidor rechaza la que ya está tomada; el dispositivo rechazado re-deriva» | **Se rechaza.** Re-derivar no devuelve el efectivo que ya salió del bolsillo. El teléfono no liquida sin sincronizar. §6 |
| `sync-and-roles.md` | ordenación por «contador por dispositivo + orden de llegada al servidor» | **Se sustituye** por la secuencia de commit del servidor con horizonte `xmin`. Hay un solo servidor: no hacen falta relojes distribuidos. §3.4 |
| `modelo-datos.md` §3 | «el móvil añade una columna `uuid` a cada tabla y hace backfill, mantiene su PK entera» | **Se confirma y se detalla.** §1 |
| `modelo-datos.md` rev. 2 | la tabla pagable se llama `labors`; existe una vista `pickups` | **Obsoleto.** Las migraciones crearon `work_records` y no hay vista `pickups`. La compatibilidad la da la fachada HTTP `/v1/pickups`. |
| `openapi.yaml`, convenciones | «toda escritura acepta `id` del cliente y es idempotente por `(farm_id, id)`» | **Hoy es falso para el ledger.** `store.AddLedgerEntry` hace un `INSERT` pelado; reenviar un pago tras un timeout choca contra la PK. Es un bug y hay que arreglarlo antes de encender el push. §4.2 |
| `arquitectura-api.md` §8 | «sync offline: no ahora» | Este documento **es** ese después. Su fecha límite ya no la fija una preferencia sino la fachada: `/v1/pickups` sólo puede traducir `cropId → plot_crop` mientras la relación sea 1:1. §8 |
| `decisiones.md` §3 | «durante la transición se paga desde un solo lado» | Esa mitigación **no termina cuando se despliega el sync**, sino en la fase 6 de §8. Antes de eso siguen siendo dos bases. |

---

## 1. Identidad: de `INTEGER AUTOINCREMENT` a UUIDv7

### 1.1 La regla

El teléfono **no** reescribe sus claves primarias. Añade `uuid TEXT` a cada
tabla sincronizable, lo rellena hacia atrás, y a partir de ahí lo genera en el
momento de insertar. El entero sigue siendo la PK y sigue siendo el destino de
todos los joins locales, de `settlement_items.pickupId`, de `ledger.settlementId`
y de `ledger.reversesId`.

El motivo es de riesgo, no de gusto. Reescribir la PK de `pickups` obliga a
reescribir `settlement_items.pickupId` **bajo el índice parcial único que decide
quién ya cobró**, en la base de datos que hoy tiene el único ejemplar de la
cosecha de una finca. Añadir una columna no puede perder una fila; reescribir
una PK sí. El coste es ~36 bytes por fila y un `JOIN` extra en la capa de sync,
y ninguno de los dos se nota en las ~55 000 filas al año de esta finca.

### 1.2 La migración local, `user_version = 6`

```sql
-- apps/mobile/src/schema.ts, SYNC_SCHEMA, aplicada en migrate() bajo v < 6.
-- Ninguna sentencia de este bloque borra, reescribe ni reordena una fila
-- existente. Es la propiedad que la hace segura a mitad de cosecha.

ALTER TABLE people           ADD COLUMN uuid TEXT;
ALTER TABLE crops            ADD COLUMN uuid TEXT;
ALTER TABLE pickups          ADD COLUMN uuid TEXT;
ALTER TABLE cost_overrides   ADD COLUMN uuid TEXT;   -- (farm, monday) en el servidor
ALTER TABLE settlements      ADD COLUMN uuid TEXT;
ALTER TABLE settlement_items ADD COLUMN uuid TEXT;
ALTER TABLE ledger           ADD COLUMN uuid TEXT;

-- Los punteros, duplicados en su forma UUID. El entero manda localmente; el
-- UUID es lo único que sale del teléfono.
ALTER TABLE pickups          ADD COLUMN personUuid   TEXT;
ALTER TABLE pickups          ADD COLUMN cropUuid     TEXT;
ALTER TABLE settlement_items ADD COLUMN payableUuid  TEXT;   -- ex pickupId
ALTER TABLE ledger           ADD COLUMN personUuid       TEXT;
ALTER TABLE ledger           ADD COLUMN settlementUuid   TEXT;
ALTER TABLE ledger           ADD COLUMN reversesUuid     TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_people_uuid    ON people(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_crops_uuid     ON crops(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pickups_uuid   ON pickups(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_settl_uuid     ON settlements(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_uuid     ON settlement_items(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_uuid    ON ledger(uuid);
```

### 1.3 El relleno hacia atrás

Sí, se rellenan. Y se rellenan con **UUIDv7 sembrado con el `createdAt` de la
fila**, no con v4 ni con `randomUUID()`:

```ts
/**
 * UUIDv7 whose timestamp field is the row's own createdAt, not now(). Two
 * consequences, and the second is the one that matters:
 *
 *  - ORDER BY uuid on the server reproduces the order the farm actually
 *    recorded things in, which is what makes an imported history read right;
 *  - the backfill is deterministic per row, so running it twice on the same
 *    database is a no-op, and a migration that dies halfway resumes.
 *
 * The 74 random bits are still random: two devices seeding from the same
 * millisecond do not collide.
 */
export function uuidv7At(createdAt: string): string { /* … */ }
```

El relleno recorre las tablas en orden de dependencia
(`people, crops → pickups → settlements → settlement_items → ledger`) y va
`WHERE uuid IS NULL`, por lotes de 500 dentro de una transacción cada uno. Al
final, la migración **verifica y falla ruidosamente** si algo quedó fuera:

```sql
SELECT (SELECT COUNT(*) FROM people           WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM crops            WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM pickups          WHERE uuid IS NULL OR personUuid IS NULL)
     + (SELECT COUNT(*) FROM settlements      WHERE uuid IS NULL)
     + (SELECT COUNT(*) FROM settlement_items WHERE uuid IS NULL OR payableUuid IS NULL)
     + (SELECT COUNT(*) FROM ledger           WHERE uuid IS NULL) AS missing;
-- missing > 0  =>  no se avanza user_version. Se prefiere una app que no arranca
-- a una app que sincroniza la mitad de una cosecha.
```

### 1.4 `settlement_items.pickupId`: qué pasa exactamente

**Se queda.** Es `INTEGER`, sigue apuntando a `pickups.id`, y sigue siendo la
columna sobre la que vive `ux_items_pickup_live`. El candado local no se toca,
porque es el único mecanismo que hoy impide que esa finca pague dos veces y
tocarlo es exactamente la operación que no se puede permitir.

Lo que se añade es `payableUuid`, rellenado desde `pickups.uuid`, y es lo único
que viaja. En el servidor esa columna ya se llama `payable_id` y su índice
`ux_items_payable_live`. La correspondencia es literal:

| Teléfono | Servidor |
|---|---|
| `settlement_items.pickupId` (INTEGER, join local) | — no viaja |
| `settlement_items.payableUuid` (TEXT) | `settlement_items.payable_id` (uuid) |
| `ux_items_pickup_live ON (pickupId) WHERE voidedAt IS NULL` | `ux_items_payable_live ON (payable_id) WHERE voided_at IS NULL` |

Los dos candados siguen existiendo. §6 explica por qué eso no es un problema
una vez que sólo uno de los dos puede crear una liquidación.

### 1.5 Dos cosas más que hay que arreglar en el teléfono para que esto funcione

**(a) `pickups.remove` es un `DELETE` de verdad.** Hoy:

```ts
remove: (id) => {
  if (pickups.isSettled(id)) throw new Error("SETTLED");
  db.runSync("DELETE FROM pickups WHERE id = ?", [id]);   // ← borrado físico
},
```

Una fila borrada físicamente después de haberse empujado **resucita en el
siguiente pull**, porque el servidor la sigue teniendo y el teléfono ya no sabe
que la mató. En `user_version = 6`, `pickups` gana `deletedAt TEXT`, `remove`
pasa a ser un `UPDATE`, y todas las consultas de `schema.ts` que leen `pickups`
ganan `AND pk.deletedAt IS NULL`. Es la misma disciplina que ya tienen `people`
y `crops`, y la misma que tiene el servidor, donde nada ejecuta un `DELETE`.

**(b) El día local del teléfono es el del dispositivo, no el de la finca.**
`DAY_OF` y `WEEK_OF` son `date(col,'localtime')`: usan la zona del teléfono.
El servidor calcula `local_day` con un trigger a partir de `farms.timezone`. Un
teléfono con la zona mal puesta manda una pesada del domingo por la tarde y el
servidor la coloca en otra semana — que es el caso de oro 04, el bug que ya
ocurrió una vez.

Solución, en `user_version = 6`: la semana y el día se **materializan al
escribir**, con la zona de la finca, usando `Intl.DateTimeFormat` (que sí tiene
la base de datos de zonas):

```sql
ALTER TABLE pickups ADD COLUMN localDay TEXT;   -- YYYY-MM-DD en la zona de la finca
ALTER TABLE pickups ADD COLUMN week     TEXT;   -- lunes de localDay
ALTER TABLE ledger  ADD COLUMN localDay TEXT;
CREATE INDEX IF NOT EXISTS ix_pickups_week ON pickups(week);
CREATE INDEX IF NOT EXISTS ix_pickups_localday ON pickups(localDay);
```

y `WEEK_BY_DAY_SQL`, `WEEK_BY_WORKER_SQL`, `WEEK_GRID_SQL`, `WEEK_PLOTS_SQL`,
`WEEK_GRID_DAY_SQL`, `PENDING_SQL` y las cinco reglas de revisión pasan a
agrupar por esas columnas en vez de recalcular `date(x,'localtime')` en cada
consulta. Es el mismo movimiento que ya hizo el servidor y por el mismo motivo,
con el efecto lateral de volver sargables consultas que hoy escanean la tabla.

Antes de que la finca reciba esa versión, la zona de la finca la trae el
handshake (§3.1) y hasta entonces se asume `America/Bogota`, que es la que ese
teléfono tiene puesta.

**(c) El precio se guarda como `REAL`.** `config.costPerUnit` y
`cost_overrides.costPerUnit` son `REAL` en pesos; el servidor tiene
`price_minor bigint`. Traer un precio del servidor y guardarlo como `REAL` mete
un `float` en el camino del dinero. En `user_version = 6` las dos tablas ganan
`costPerUnitCents INTEGER`, se rellena con `toCents(costPerUnit)`, y
`costForWeek` devuelve centavos. La columna `REAL` se queda para las pantallas
viejas hasta que se reescriban, pero **ninguna ruta de dinero la lee**.

---

## 2. Qué se sincroniza y en qué dirección

`↑` empuja el teléfono · `↓` lo recibe el teléfono · `↕` los dos · `—` no viaja.

| Tabla del teléfono | Tabla del servidor | Dir. | Regla |
|---|---|---|---|
| `people` | `employees` | ↕ | El teléfono da de alta gente en el campo. Los campos que sólo existen en la web (foto, teléfono, dirección) llegan por `↓` y el teléfono no los pisa: el push manda **sólo los campos que la pantalla del teléfono edita**. |
| `crops` | `plot_crops` (+ su `plots`) | ↓ | **Sólo lectura en el teléfono.** §2.1 |
| `pickups` | `work_records` (`pay_scheme='unidad_trabajo'`) | ↕ | El teléfono empuja pesadas; recibe las labores por unidad de trabajo que registró la web. Las labores por contrato y por tiempo **no bajan al teléfono** en la primera versión. §2.2 |
| `config` | `farm_config`, `farms` | ↓ | Nombre, cultivo, unidad, zona horaria, moneda, precio general. El teléfono no los edita más. |
| `config.language` | — | — | Preferencia del dispositivo. Nunca viaja. |
| `cost_overrides` | `week_prices` | ↓ | **Sólo lectura en el teléfono.** §2.1 |
| `settlements` | `settlements` | ↓ | Las crea el servidor y sólo el servidor. §6 |
| `settlement_items` | `settlement_items` | ↓ | Ídem. Llegan siempre con su liquidación, en el mismo lote. |
| `ledger` `pago`/`anticipo`/`deduccion`/`ajuste`/`reverso` | `ledger` | ↕ | Un movimiento es un hecho: se empuja y se acepta. §2.3 |
| `ledger` `devengo` | `ledger` | ↓ | Lo produce `POST /v1/settlements`. El teléfono no puede escribir uno. |
| saldos, `BALANCE_SQL` | — | — | Derivado. Se recalcula a los dos lados. Nunca viaja un total. |
| IRL, anomalías, rendimiento, reportes de semana/lote/trabajador | — | — | Derivados de lo anterior. Nunca viajan. |
| `demo`, `seed`, `clear` | — | — | Nunca. Un `seed` sobre una finca sincronizada es una catástrofe con un botón. La pantalla se esconde cuando el teléfono está emparejado. |

### 2.1 Por qué precios y parcelas son de sólo lectura

Son las dos entradas cuya edición cambia dinero **hacia atrás y para todo el
mundo a la vez**.

Un precio semanal editado en dos sitios con "gana el último" reprecia la semana
entera de la finca; no hay conflicto que resolver porque no hay una fila en
disputa, hay una nómina. Un solo escritor —el dueño, en la web, donde
`p_week_prices_write` ya exige rol `owner`— elimina la clase entera de errores.

Las parcelas son peor. `POST /v1/pickups` traduce `cropId → plot_crop` y esa
traducción es 1:1 y determinista **sólo mientras un lote tenga un cultivo**. Si
el teléfono puede inventar lotes sin señal, dos pesadores crean "Lote 1" y
"lote 1" el mismo día, y ninguna fusión automática puede saber después si eran
el mismo. Fusionar lotes es trabajo manual del dueño con una pantalla, no una
adivinanza de un script.

**Lo que se pierde, dicho claro:** hoy el teléfono puede crear un lote y cambiar
el precio de la semana sin señal, y después de esto no. Es una pérdida de
producto real y está en §10 para que el dueño la firme.

### 2.2 Las labores que el teléfono no entiende

Por decisión 3 la web ya registra labores por contrato y por tiempo. El teléfono
no tiene pantalla para eso y no la va a tener en esta entrega.

**No se le mandan.** El pull filtra `pay_scheme = 'unidad_trabajo'`, igual que
la fachada `/v1/pickups`. Un jornal en una pantalla que sólo sabe enseñar kilos
es peor que nada — que es exactamente lo que ya decidió `GET /v1/pickups/{id}`
al devolver 404 para una labor que no es por unidad de trabajo.

Consecuencia que hay que decir: **el teléfono no puede mostrar el saldo completo
de un trabajador que además hizo jornales.** Su `BALANCE_SQL` local sumará sólo
los movimientos que él conoce. Y por eso el saldo del teléfono deja de ser la
verdad: la pantalla de saldo pasa a mostrar el saldo que vino del servidor
(§3.3, `balances` en el feed) con la marca de cuándo llegó, y el saldo local
derivado sólo se usa mientras hay cosas sin empujar, etiquetado como
«provisional».

### 2.3 Por qué el dinero saliente sí se empuja, y sin condiciones

Un `pago`, un `anticipo` o una `deduccion` es un hecho: alguien entregó
efectivo. Rechazar su llegada no deshace el hecho, sólo hace que la base mienta.

Por eso el canal de sync empuja movimientos de ledger **y el servidor los acepta
sin comprobar el saldo**. En concreto: la validación
`AMOUNT_EXCEEDS_BALANCE` de `POST /v1/payments` es una defensa contra un dedazo
en la pantalla de pago de la web, y es correcta ahí. En el canal de sync se
comporta como `allowOverpayment: true`, que es exactamente lo que ya hace el
teléfono hoy y lo que fija el caso de oro 07 (`pago-mayor-al-saldo`): el saldo
se va a negativo y el exceso se comporta como anticipo. El saldo no se recorta.

Esto no abre la puerta al doble pago. Un pago no reclama ninguna pesada, no toma
ningún candado, y dos pagos duplicados por error humano se ven a simple vista en
el historial del trabajador — que es un problema de personas, no de merge.

---

## 3. El mecanismo

Un feed de cambios con secuencia por finca. El teléfono lleva **un solo número**:
`sync_state.cursor`. Lo que le falta es «todo lo que tenga `seq` mayor que ese
número».

No es push/pull con marca de agua por tabla. Una marca de agua por tabla obliga
a `updated_at` en todas partes, no distingue un borrado de una fila que nunca
existió, y se rompe con relojes: dos filas escritas en el mismo milisegundo, una
antes y otra después del corte, y una de las dos no se ve nunca más. Una
secuencia es un entero que sólo sube y que asigna un único servidor.

### 3.1 `POST /v1/sync/handshake`

Lo primero que hace el teléfono al emparejarse, y en cada arranque de la app.

```jsonc
// →
{ "deviceId": "0192f0…",          // uuid del dispositivo, estable, generado una vez
  "appVersion": "1.7.0",
  "schemaVersion": 6,
  "cursor": 148213 }              // 0 la primera vez

// ← 200
{ "farmId": "0192e1…",
  "timezone": "America/Bogota",   // con esto el teléfono calcula localDay y week
  "currency": "COP", "minorUnit": 2,
  "serverTime": "2026-08-29T14:02:11Z",
  "cursor": 149004,               // dónde está el servidor ahora
  "behind": 791,                  // cuántos cambios le faltan al teléfono
  "role": "weigher",              // lo que este token puede hacer
  "capabilities": {               // lo que la app debe habilitar o esconder
    "settleOffline": false,
    "writePlots": false,
    "writeWeekPrices": false
  } }
```

`capabilities` no es cortesía: es lo que apaga botones en la app sin que haya
que desplegar una versión nueva cuando §10 cambie de opinión. Y no sustituye a
la autorización: el servidor sigue devolviendo 403 aunque el botón esté visible,
porque esconder un botón no es un permiso.

**409 `SCHEMA_TOO_OLD`** si `schemaVersion < 6`: el teléfono sabe que tiene que
actualizarse antes de tocar nada y no empuja ni un byte.

### 3.2 `POST /v1/sync/push`

Un lote ordenado de sobres. El orden es el de inserción local (`rowid`), que es
el orden causal: un padre siempre se insertó antes que su hijo.

```jsonc
// →
{ "deviceId": "0192f0…",
  "ops": [
    { "opId": "0192f1a0-…",       // uuid del sobre. LA CLAVE DE IDEMPOTENCIA.
      "entity": "worker",
      "op": "upsert",
      "payload": { "id": "0192e5…", "name": "Ana", "lastName": "Rodríguez",
                   "documentType": "CC", "docId": "1098…", "tag": "17",
                   "createdAt": "2026-08-20T13:02:00Z", "deletedAt": null } },

    { "opId": "0192f1a1-…",
      "entity": "workRecord",
      "op": "upsert",
      "payload": { "id": "0192e6…", "workerId": "0192e5…",
                   "cropId": "0192e2…",          // plot_crop
                   "quantity": 12.5,
                   "occurredAt": "2026-08-24T19:30:00-05:00",   // INSTANTE con desfase
                   "note": null, "deviceId": "0192f0…", "deletedAt": null } },

    { "opId": "0192f1a2-…",
      "entity": "ledgerEntry",
      "op": "append",
      "payload": { "id": "0192e7…", "workerId": "0192e5…", "kind": "anticipo",
                   "amountCents": 5000000, "date": "2026-08-24",
                   "method": "efectivo", "note": "adelanto en el lote" } }
  ] }
```

```jsonc
// ← 200  (siempre 200: el estado de cada op está en su fila)
{ "cursor": 149006,               // el teléfono puede seguir pulling desde aquí
  "results": [
    { "opId": "0192f1a0-…", "status": "applied",   "id": "0192e5…" },
    { "opId": "0192f1a1-…", "status": "duplicate", "id": "0192e6…" },
    { "opId": "0192f1a2-…", "status": "rejected",
      "error": { "code": "WORK_RECORD_SETTLED",
                 "message": "…",
                 "details": { "settlementId": "0192d0…" } } }
  ] }
```

Reglas del push, todas obligatorias:

- **Cada op corre en su propio `SAVEPOINT`.** Un rechazo no tumba el lote. Un
  lote de 200 pesadas donde una apunta a un trabajador que la web borró tiene
  que meter las otras 199.
- **Tamaño máximo 200 ops o 1 MB.** El teléfono trocea. En una red de finca, un
  lote grande es un lote que nunca termina.
- **El instante viaja con desfase (`occurredAt`), nunca un día suelto.** El
  `local_day` lo escribe el trigger del servidor con la zona de la finca y Go
  no lo escribe nunca. Es el mismo acuerdo que hace que el caso 04 salga bien
  de los dos lados.
- **`op: "append"` para el ledger, `op: "upsert"` para el resto.** No existe
  `op: "delete"`: un borrado es un `upsert` con `deletedAt`. No hay borrado
  físico en ninguna dirección.
- El teléfono **no borra su fila del outbox por optimismo**: sólo cuando el
  `result` de ese `opId` llega con `applied`, `duplicate` o `rejected`.

### 3.3 `GET /v1/sync/pull?cursor=149006&limit=500`

```jsonc
// ← 200
{ "changes": [
    { "seq": 149007, "entity": "weekPrice", "op": "upsert",
      "row": { "weekStart": "2026-08-24", "priceCents": 95000 } },
    { "seq": 149008, "entity": "settlement", "op": "upsert",
      "row": { "id": "0192d1…", "workerId": "0192e5…",
               "periodStart": "2026-08-17", "periodEnd": "2026-08-30",
               "grossCents": 1187500, "status": "open",
               "createdAt": "2026-08-29T10:04:00Z", "voidedAt": null,
               "items": [ { "id": "0192d2…", "payableId": "0192e6…",
                            "weekStart": "2026-08-24", "quantity": 12.5,
                            "priceCents": 95000, "amountCents": 1187500,
                            "voidedAt": null } ] } },
    { "seq": 149009, "entity": "ledgerEntry", "op": "append",
      "row": { "id": "0192d3…", "workerId": "0192e5…", "kind": "devengo",
               "amountCents": 1187500, "date": "2026-08-29",
               "settlementId": "0192d1…", "reversesId": null } }
  ],
  "cursor": 149009,
  "more": false,
  "balances": [ { "workerId": "0192e5…", "balanceCents": 1187500 } ] }
```

- **Una liquidación viaja entera, con sus líneas.** Nunca una cabecera sin sus
  renglones: un documento de $1.187.500 con nada debajo es exactamente lo que la
  migración `user_version = 4` del teléfono existió para arreglar.
- `balances` es un **checksum, no un dato**. El teléfono recalcula el saldo con
  su propio `BALANCE_SQL` y compara. Si difieren, no copia el número del
  servidor: marca al trabajador y lo saca en la pantalla de §7. Un saldo que
  llega por el cable y se guarda es el total materializado que todo este diseño
  lleva tres documentos rechazando. Sólo llega en el último lote (`more:false`),
  cuando el teléfono ya está al día.
- El teléfono aplica los cambios **en orden de `seq`, en una transacción por
  lote**, y sólo entonces avanza su cursor. Un corte a mitad deja el cursor
  donde estaba y el lote se repite: aplicar dos veces un `upsert` por UUID es
  un no-op.

### 3.4 El feed, por dentro

```sql
-- +goose Up
CREATE TABLE sync_log (
  seq     bigserial PRIMARY KEY,
  farm_id uuid   NOT NULL REFERENCES farms(id),
  entity  text   NOT NULL,
  row_id  uuid   NOT NULL,
  op      text   NOT NULL CHECK (op IN ('upsert','append')),
  -- The transaction that wrote this row. It is what closes the hole that a
  -- bare sequence leaves: nextval() hands out numbers BEFORE commit, so a
  -- reader can see seq 100 committed while seq 99 is still in flight, take
  -- cursor 100, and never see 99 again. See the horizon below.
  xact    xid8   NOT NULL DEFAULT pg_current_xact_id(),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_log_farm ON sync_log (farm_id, seq);
CREATE UNIQUE INDEX ux_sync_log_row ON sync_log (farm_id, entity, row_id, seq);
```

Lo escriben triggers `AFTER INSERT OR UPDATE` en `employees`, `plots`,
`plot_crops`, `work_records`, `week_prices`, `farm_config`, `settlements`,
`settlement_items` y `ledger`. Triggers y no código Go, por lo mismo que el
`local_day`: la fila que se escriba por una ruta que nadie previó también tiene
que aparecer en el feed.

La consulta del pull, con el horizonte:

```sql
-- The horizon: the lowest seq still owned by a transaction that may not have
-- committed. Everything strictly below it is final, in order, for ever.
WITH h AS (
  SELECT COALESCE(MIN(seq),
                  (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log WHERE farm_id = current_farm()))
    AS horizon
    FROM sync_log
   WHERE farm_id = current_farm()
     AND seq > $1
     AND xact >= pg_snapshot_xmin(pg_current_snapshot())
)
SELECT s.seq, s.entity, s.row_id, s.op
  FROM sync_log s, h
 WHERE s.farm_id = current_farm()
   AND s.seq > $1
   AND s.seq < h.horizon
 ORDER BY s.seq
 LIMIT $2;
```

Una fila retenida por el horizonte no se pierde: aparece en el siguiente sondeo,
en su sitio. Lo que el horizonte garantiza es que **el cursor nunca salta por
encima de un cambio**, que es la única propiedad que hace que "un solo número"
sea suficiente.

La fila del feed lleva sólo la identidad; el cuerpo se compone en el momento del
pull leyendo la tabla real. Así una fila corregida cinco veces se manda una vez,
en su estado actual, y el feed no es una segunda copia del dinero que pueda
divergir de la primera.

**Retención:** `sync_log` se poda a 180 días. Un teléfono cuyo cursor sea
anterior al mínimo retenido recibe `409 CURSOR_TOO_OLD` y hace un **bootstrap**:
`GET /v1/sync/bootstrap`, que devuelve el estado completo de la finca paginado y
un cursor nuevo. Es lento y no pasa nunca, y por eso existe.

### 3.5 Cuándo sincroniza

Al abrir la app, al volver a primer plano, cada 15 minutos con red, al pulsar el
chip de §7, y **siempre antes de abrir cualquier pantalla de dinero**. Nada de
websockets ni de notificaciones push: la finca tiene señal en la casa por la
noche, el pesador no la tiene en el lote, y una conexión persistente sobre esa
red es una batería gastada a cambio de nada.

---

## 4. Idempotencia y reintentos

La red se cae a la mitad. Es el caso normal, no el excepcional. Reenviar tiene
que ser seguro, y lo es por **tres capas independientes**, cada una suficiente
para un tipo distinto de fallo.

### 4.1 Capa 1 — la identidad es del cliente

Toda fila lleva un UUIDv7 generado en el teléfono antes de tocar la red. La
escritura del servidor es, sin excepción:

```sql
INSERT INTO work_records (id, farm_id, …) VALUES ($1, $2, …)
ON CONFLICT (id) DO NOTHING
RETURNING …;
-- Cero filas devueltas => ya estaba => status "duplicate" y el mismo recurso.
```

Esto cubre el fallo más común: la petición llegó, el servidor escribió, la
respuesta se perdió. El teléfono reenvía, el `ON CONFLICT` no hace nada, y el
teléfono recibe la fila que ya existía. **Un reintento no puede crear una
segunda pesada porque no puede inventar un segundo UUID: el UUID se generó al
pulsar el botón, no al mandar.**

### 4.2 Capa 2 — el registro de operaciones

```sql
CREATE TABLE sync_ops (
  op_id     uuid PRIMARY KEY,
  farm_id   uuid NOT NULL REFERENCES farms(id),
  device_id uuid NOT NULL,
  status    text NOT NULL CHECK (status IN ('applied','duplicate','rejected')),
  result    jsonb NOT NULL,      -- la respuesta exacta que se devolvió
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sync_ops_device ON sync_ops (farm_id, device_id, at DESC);
```

El servidor, antes de aplicar un sobre, mira `sync_ops`. Si el `opId` está,
devuelve `result` **literalmente**, sin volver a ejecutar nada. Esto cubre el
fallo que la capa 1 no cubre: operaciones que no son un insert de una fila con
UUID propio —anular, reversar— y cuyo segundo intento tendría un resultado
distinto del primero.

Retención de `sync_ops`: 30 días. Un reintento a los 30 días no es un reintento.

### 4.3 Capa 3 — la semántica ya es idempotente, y esa es la buena

Aquí es donde el ledger append-only paga lo que costó. Las operaciones del
sistema son de tres clases y ninguna necesita "resolverse":

- **Añadir un hecho** (pesada, pago, anticipo, deducción, ajuste). Añadir
  conmuta. Dos dispositivos que añadieron se funden tomando la unión. No hay
  merge, hay `UNION`.
- **Tomar un candado que sólo se puede tomar una vez.** El segundo intento choca
  con un índice único y devuelve un 409 **que significa "ya está hecho"**:
  `PAYABLE_ALREADY_CLAIMED` con la liquidación ganadora, `ALREADY_REVERSED`,
  `SETTLEMENT_ALREADY_VOID`. El cliente los trata como éxito, no como error.
- **Derivar un total.** Nunca se transmite. Se recalcula.

Por eso la tabla de comportamiento del cliente ante cada código es corta y no
tiene casilla ambigua:

| Respuesta | Qué hace el teléfono |
|---|---|
| `applied` / `duplicate` | Marca la op como enviada. Borra la fila del outbox. |
| `PAYABLE_ALREADY_CLAIMED` | Éxito. Guarda `details.winningSettlement` y espera a que baje por el feed. |
| `ALREADY_REVERSED`, `SETTLEMENT_ALREADY_VOID` | Éxito. Borra del outbox. |
| `WORK_RECORD_SETTLED` | **Conflicto.** A la pantalla de §7. No se reintenta. |
| `NOT_FOUND` (padre ausente) | Reintenta una vez en el lote siguiente; si vuelve, conflicto. |
| `BAD_REQUEST` | Bug del cliente. No se reintenta jamás — un reintento en bucle contra un 400 es cómo una app se come una batería y un plan de datos. Se registra y se sube al log. |
| `401`, `403` | Renueva el token; si vuelve, para el sync y avisa. |
| `429`, `5xx`, timeout, sin red | Reintento con retroceso exponencial: 2s, 4s, 8s… hasta 15 min, con *jitter*. Sin límite de intentos: el teléfono tiene todo el tiempo del mundo y los datos no caducan. |

### 4.4 El bug que hay que arreglar antes de encender nada

`store.AddLedgerEntry` hace un `INSERT` pelado sin `ON CONFLICT`. Reenviar un
pago con el mismo `id` tras un timeout no devuelve 200 con el movimiento
existente: choca contra la PK y sale como error de servidor. Eso contradice la
convención que el propio `openapi.yaml` declara en su cabecera y **rompe la capa
1 justo en la tabla del dinero**.

```go
// store/money.go — AddLedgerEntry
// A retry after a lost response must return the movement that already exists,
// not a unique violation. This is the one write where the phone's idempotency
// guarantee was missing.
INSERT INTO ledger (id, farm_id, employee_id, kind, amount_minor, local_day,
                    method, note, created_by)
VALUES ($1, …)
ON CONFLICT (id) DO NOTHING
RETURNING …
-- 0 filas => SELECT la existente y devolver 200 en vez de 201.
```

Lo mismo en `POST /v1/payments|advances|deductions|adjustments`: si el `id` ya
existe, `200` con la fila existente. Es un cambio de tres líneas por handler y
un test de contrato que lo fije. **Sin esto no se enciende el push.**

---

## 5. Los conflictos, uno por uno

No en abstracto. Cada uno con su ganador y su motivo.

### 5.1 Dos dispositivos registran la misma pesada

**No es un conflicto. Son dos pesadas.**

Cada teléfono generó un UUID distinto, los dos entran, los dos se pagan. La
identidad de una fila es su UUID y **nada más**: no se deduplica jamás por
`(persona, lote, peso, minuto)`, porque dos recolectores pesan de verdad 12,5 kg
en el mismo lote en el mismo minuto, y un merge que decida que eran la misma
roba un jornal a alguien sin dejar rastro.

Lo que sí ocurre es que si de verdad fue un error humano —el pesador anotó dos
veces— eso es un duplicado, y para eso ya existe `RULE_DUPLICATE_SQL`, que se
porta al servidor y ahora corre sobre el conjunto **fundido**, que es donde por
primera vez puede verlo. Sale en la pantalla de revisión como sospecha, con dos
botones, y lo decide una persona.

El único caso que sí se deduplica es el mismo dispositivo reenviando: mismo
UUID, `ON CONFLICT DO NOTHING`.

### 5.2 El teléfono liquida una semana que el servidor ya liquidó

**Bajo §6 esto no puede ocurrir**, porque el teléfono no crea liquidaciones sin
haber sincronizado y las crea llamando al servidor. Queda por completitud el
caso de dos usuarios de la web liquidando a la vez, y el caso del periodo de
transición antes de la fase 6 de §8.

**Gana el que confirmó primero en Postgres.** No el que lo pidió primero, no el
que tiene el reloj más rápido: el que ganó la carrera en `ux_items_payable_live`.
El perdedor recibe:

```jsonc
409 { "error": { "code": "PAYABLE_ALREADY_CLAIMED",
                 "details": { "payableId": "0192e6…",
                              "winningSettlement": { "id": "0192d1…",
                                                     "grossCents": 1187500,
                                                     "createdAt": "…" } } } }
```

y el motivo por el que el ganador es el candado y no una regla nuestra es que el
candado es lo único que no puede equivocarse: es la misma transacción que
escribe. Cualquier arbitraje en Go es un `SELECT` seguido de un `INSERT`, y entre
los dos cabe la otra liquidación.

### 5.3 Una pesada llega tarde, de una semana ya liquidada

**No es un conflicto y no hace falta hacer nada. Ya está resuelto y hay un caso
de oro que lo fija** (09, `pesada-tardia-de-semana-ya-liquidada`).

`PENDING_SQL` selecciona **por id de pagable, no por fecha**:

```sql
AND pk.id NOT IN (SELECT pickupId FROM settlement_items WHERE voidedAt IS NULL)
```

Una pesada que llega tarde simplemente no está reclamada, así que entra en la
liquidación siguiente, **al precio de su propia semana** (`week_prices` de su
lunes, no del lunes de la liquidación). La liquidación ya emitida no se reabre,
no se recalcula y no se corrige: el recibo que el trabajador tiene en la mano
sigue siendo verdad.

**Ninguna liquidación cerrada se reabre nunca, por ningún motivo.** Si hay que
cambiar una, se anula y se rehace, que es lo que hace el caso 05.

### 5.4 Alguien anula en la web una liquidación que el teléfono aún cree viva

**Gana el servidor, siempre, y no hay nada que preguntar.**

Anular no borra: marca `settlement_items.voided_at` —que es lo que suelta el
candado—, pone `settlements.status = 'void'`, y asienta un `reverso` del
`devengo`. Las tres cosas bajan por el feed en el mismo lote, el teléfono las
aplica, y su saldo se re-deriva solo.

Lo importante es lo que **no** pasa: el `pago` que el pesador ya hizo contra esa
liquidación **no se toca**. Sigue en el ledger, con su signo negativo. El
resultado es que el trabajador queda debiendo lo que cobró, que es exactamente
el caso de oro 05 y exactamente lo correcto: la finca le dio un dinero y la
liquidación que lo justificaba ya no existe.

No hace falta pantalla de conflicto. Hace falta un aviso en la ficha del
trabajador con las tres cifras: lo anulado, lo pagado, lo que queda debiendo.

### 5.5 El precio de la semana cambió entre que el teléfono liquidó y sincronizó

**Bajo §6, el teléfono no liquida sin señal, así que el precio se aplica una sola
vez, en el servidor, en el momento de liquidar.** El caso se reduce a otro: la
pantalla mostró una previsualización y el importe real salió distinto.

Eso sí puede pasar, en segundos, si el dueño cambia el precio desde la web
mientras el administrador mira la pantalla de liquidar. Y una liquidación que
sale por un importe distinto del que la persona leyó antes de pulsar es
inaceptable, porque esa persona va a contar ese efectivo.

**Cambio obligatorio en el contrato:** `SettlementInput` gana un campo opcional.

```yaml
    SettlementInput:
      properties:
        expectedGrossCents:
          type: integer
          format: int64
          description: |
            What the caller was shown by /v1/settlements/preview. If the
            settlement would not add up to this, the server writes nothing and
            answers 409 GROSS_CHANGED with the new figure. A settlement that
            comes out to a different number than the one the person read before
            pressing the button is a number they are about to count out in cash.
```

y un código nuevo, `GROSS_CHANGED`, con
`details: { expectedCents, actualCents, changedWeeks: ["2026-08-24"] }`.

La app **siempre** lo manda. La pantalla enseña las dos cifras y la semana que
cambió, y el operador confirma o cancela. No se elige un precio
automáticamente: el precio nuevo puede ser una corrección o un dedazo, y el
servidor no puede saber cuál.

### 5.6 Un empleado borrado en la web tiene pesadas nuevas del teléfono

**La pesada entra. El empleado sigue de baja. Ni se rechaza ni se resucita.**

La baja es lógica (`employees.deleted_at`), así que la FK compuesta sigue
resolviendo y el `INSERT` del `work_record` funciona sin tocar nada. Las dos
alternativas son peores: rechazar pierde trabajo que se hizo de verdad, y
resucitar sobrescribe en silencio una decisión que tomó el dueño.

El dinero sigue funcionando: `BALANCE_SQL` no mira `deleted_at`, y `BalanceRow`
ya trae `inactive` precisamente para esto — *«Money is never hidden, only
marked»*. El trabajador cobra.

El par (pesada nueva, empleado de baja) sale en la pantalla de §7 como
«Registraste trabajo de alguien que fue dado de baja», con dos botones: **Volver
a darlo de alta** y **Era otra persona**.

**El peligro de verdad está en otro sitio**, y hay que taparlo: `ux_employees_doc`
es parcial `WHERE deleted_at IS NULL`. Después de dar de baja a Juan, la web
puede crear un segundo Juan con la misma cédula. Entonces hay dos empleados, el
teléfono apunta al viejo, y el saldo de una persona queda partido en dos fichas
sin que nada avise. Fusionarlas después es cirugía manual sobre el ledger.

**Cambio obligatorio:** `POST /v1/workers` con un `(documentType, docId)` que
coincida con un empleado dado de baja responde
`409 EMPLOYEE_EXISTS_DELETED` con `details.employeeId`, y la web ofrece
restaurarlo en vez de crear otro. Es un `SELECT` extra en un alta y evita el
único conflicto de este documento que no tiene arreglo automático.

### 5.7 Los cuatro que no estaban en la lista y muerden igual

**(a) Una pesada editada sin señal que el servidor ya liquidó.** El teléfono
tiene `pickups.setWeight` con su `isSettled`; el servidor devuelve
`409 WORK_RECORD_SETTLED`. Gana el servidor. El teléfono **guarda el cambio como
corrección pendiente y lo enseña** —no lo descarta y no lo aplica—, con la frase
de §7. Anular la liquidación no es un botón de esa pantalla: es una decisión del
dueño en una pantalla que enseña lo que anular cuesta.

**(b) Una pesada borrada sin señal que el servidor ya liquidó.** Idéntico. El
borrado local se revierte al aplicar el pull, y el intento queda como conflicto.

**(c) Dos teléfonos con relojes descuadrados días enteros.** El orden de merge es
el `seq` del servidor y nada más. Lo que la app enseña como fecha es el instante
que grabó el dispositivo, y el día de negocio lo calcula el trigger con la zona
de la finca. Una pesada con `occurredAt` en el futuro **se acepta** y la marca
`RULE_FUTURE_SQL`: rechazarla en la frontera pierde trabajo real por culpa de un
reloj mal puesto, que es el problema equivocado.

**(d) Una pesada apunta a un cultivo que la web dio de baja.** `plot_crops` tiene
`deleted_at` y la FK sigue resolviendo. Entra. No es conflicto. El día que un
lote tenga dos cultivos, la fachada `/v1/pickups` deja de poder traducir
`cropId` y el teléfono **tiene** que estar ya en `/v1/work-records`; eso no es un
conflicto de sincronización, es la fecha límite de §8.

---

## 6. El candado

### 6.1 La decisión

> **El servidor es el dueño del candado. El teléfono no crea liquidaciones. Una
> liquidación se pide con `POST /v1/settlements`, en línea, con el cursor al día.
> El efectivo entregado en el lote sin señal se registra como `anticipo`.**

`ux_items_payable_live` en Postgres es el único candado que decide. El candado
local del teléfono, `ux_items_pickup_live`, se queda —protege las liquidaciones
importadas y las que bajan por el feed de que una segunda las reclame— pero deja
de ser quien las crea.

La pantalla de liquidar exige dos cosas antes de habilitar el botón: un `pull`
completado en la sesión actual (`more:false`) y el outbox vacío para ese
trabajador. Si falta cualquiera de las dos, el botón está apagado con esta
frase, y con el botón de anticipo **al lado, no en otro menú**:

> Para liquidar hay que sincronizar. Sin señal puedes entregar un anticipo: se
> descuenta solo cuando se liquide.

### 6.2 Por qué el anticipo resuelve de verdad el trabajo sin señal

Esto no es un consuelo, es la respuesta técnica correcta.

Un `anticipo` **no reclama ninguna pesada**. No toca `settlement_items`, no toma
ningún candado, y por eso dos dispositivos que registran anticipos sin señal se
funden por unión sin ninguna posibilidad de conflicto. Y no es un apaño
contable: cuando llega la liquidación, el `devengo` positivo se suma al
`anticipo` negativo en el mismo `SUM(amount_minor)` y el saldo sale exacto. Es
lo que fija el caso de oro 02, `anticipo-mayor-que-la-semana`: un anticipo mayor
que la semana se amortiza contra varias, con el saldo comprobado semana a
semana.

El pesador entrega efectivo en el lote, imprime un recibo de anticipo, y el
trabajador ve su saldo bajar. Lo único que no puede hacer sin señal es **cerrar**
la semana y emitir el documento definitivo — y cerrar una semana es un acto de
oficina, no de lote.

### 6.3 Lo que se pierde con cada opción, incluida la elegida

| | Qué hace | Qué se pierde |
|---|---|---|
| **A. Servidor dueño (elegida)** | El teléfono no liquida sin sincronizar; anticipo como salida en campo | Cerrar una semana y emitir el recibo definitivo sin señal. **Hoy la app lo hace y dejará de hacerlo.** Mitigado: el anticipo también imprime recibo, y la liquidación posterior lo amortiza al centavo. |
| **B. Liquidar offline y arbitrar al llegar** (lo que propone `sync-and-roles.md`) | El teléfono liquida; el servidor rechaza al perdedor y le manda la ganadora para re-derivar | **El efectivo del perdedor ya está en el bolsillo del recolector.** Hay que deshacer una liquidación después de que el dinero se movió — que es literalmente el fallo que todo este sistema existe para evitar. Y el perdedor es el que estuvo sin señal, o sea el pesador, o sea el que menos puede arreglarlo. |
| **C. Reserva con arriendo** | Estando en línea el teléfono reserva un conjunto de pagables y puede liquidarlos offline hasta que caduque | Complejidad real (caducidad, renovación, liberación tras un teléfono perdido) a cambio de algo que **sólo funciona si el teléfono estuvo en línea hace poco** — que es exactamente cuando A también funciona. Y un teléfono que se cae al río deja pesadas bloqueadas hasta que expire el arriendo. |
| **D. Candado partido por dispositivo** | Cada dispositivo sólo puede liquidar lo que él registró | Rompe la garantía de **una** liquidación por trabajador: quien recolectó con dos pesadores recibe dos documentos y dos recibos. Es exactamente el problema de las dos tablas pagables que `arquitectura-api.md` §1 rechazó, reintroducido por la puerta de atrás. |

El argumento que decide entre A y B no es técnico, es de quién hace qué. **El
que trabaja días sin señal es el pesador, y el pesador no liquida:** las RLS
`p_ledger`, `p_settlements` y `p_settlement_items` ya le niegan el dinero
entero. El que liquida es el dueño o el administrador, y ese sí baja a la casa,
a la cooperativa o al pueblo. Estamos pidiendo señal exactamente a quien la
tiene.

### 6.4 Y si el dueño no acepta perder la liquidación offline

Entonces la respuesta **no** es B. Es: la liquidación offline se mantiene, se
marca `provisional`, imprime un recibo que dice «provisional» en letra grande,
y **no puede pagarse contra ella hasta que sincronice**. Un `pago` con
`settlementId` de una liquidación provisional queda bloqueado en el teléfono.
Eso conserva el flujo de trabajo y mueve la restricción del sitio donde no duele
—registrar— al sitio donde sí importa —entregar el efectivo—. Es más código y
una pantalla más, y es la única variante de B que no puede pagar dos veces.

---

## 7. Qué ve el usuario

El principio: **la pantalla de pesar no se bloquea nunca, y ningún conflicto se
cierra sin una decisión.** Una pantalla de conflictos que nadie entiende no
sirve, y una que nadie puede cerrar es peor.

### 7.1 El chip de estado

Uno, en la cabecera, siempre visible, tocable. Cuatro estados y ninguno es un
*spinner* solo:

| Estado | Texto | Color |
|---|---|---|
| Al día | «Sincronizado · hace 3 min» | neutro |
| Pendiente | «12 sin enviar» | neutro |
| Sin red | «Sin señal · 12 pendientes» | ámbar |
| Conflicto | «3 necesitan tu decisión» | rojo, y sólo este es rojo |

Tocarlo abre el detalle: cuántas pesadas, cuántos pagos, desde cuándo, y un
botón «Sincronizar ahora». **El número de pendientes no es un adorno**: es lo que
un dueño mira antes de irse del lote.

### 7.2 Lo que no está enviado

Un punto pequeño en la fila, en las listas donde ya hay filas: pesadas
recientes, movimientos del trabajador. Sin modales, sin banners, sin bloquear.
Al lado del punto, en la ficha, una línea: «Pendiente de enviar». Y nada más:
una pesada sin enviar es una pesada perfectamente buena.

### 7.3 La pantalla de conflictos

Una tarjeta por problema. Cada tarjeta **tiene que traer una persona, una fecha
y un importe o una cantidad** — una tarjeta sin nombre y sin cifra no es una
tarjeta, es ruido y se quita del diseño.

```
┌──────────────────────────────────────────────┐
│ Ana Rodríguez · martes 25 de agosto          │
│                                              │
│ Cambiaste esta pesada de 12,5 kg a 13,0 kg,  │
│ pero ya se pagó en la liquidación del 26 de  │
│ agosto, por $1.187.500.                      │
│                                              │
│ [ Ver la liquidación ]  [ Descartar mi cambio ]│
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Juan Pérez · 3 pesadas, 41,2 kg              │
│                                              │
│ Registraste trabajo suyo, pero fue dado de   │
│ baja en la web el 20 de agosto. El trabajo   │
│ quedó guardado y su saldo está correcto.     │
│                                              │
│ [ Volver a darlo de alta ]  [ Era otra persona ]│
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Ana Rodríguez · liquidación del 26 de agosto │
│                                              │
│ Esta liquidación se anuló desde la web el 29 │
│ de agosto. El pago de $1.187.500 que hiciste │
│ sigue en el historial, así que Ana queda     │
│ debiendo $1.187.500.                         │
│                                              │
│ [ Entendido ]  [ Ver el historial de Ana ]   │
└──────────────────────────────────────────────┘
```

Reglas de esa pantalla, no negociables:

- **Como máximo dos botones.** Si hacen falta tres, es que uno de ellos es una
  decisión del dueño y va en otro sitio (anular una liquidación es el ejemplo).
- **Nunca un diff de dos JSON.** Nunca «versión local / versión remota». La
  finca no piensa en versiones, piensa en Ana y en el martes.
- **Nada se auto-resuelve ni desaparece solo.** Una tarjeta se cierra porque
  alguien pulsó, y queda registrada en el historial de conflictos con quién
  pulsó qué.
- **Los conflictos de dinero no se le enseñan al pesador.** El rol ya se lo
  niega en el servidor; la pantalla filtra por rol y al pesador sólo le llegan
  los suyos: pesadas rechazadas y empleados de baja.

### 7.4 Los saldos, mientras haya cosas sin enviar

La ficha del trabajador enseña el saldo con una etiqueta cuando el teléfono no
está al día:

> Saldo $340.000 · **provisional**, faltan 4 movimientos por enviar

y si el `balances` del pull (§3.3) no cuadra con el `BALANCE_SQL` local
estando todo enviado y todo recibido, eso **no** se arregla copiando el número:
sale una tarjeta roja con las dos cifras y un botón «Enviar informe». Es un bug
de cálculo entre dos implementaciones del mismo dinero, y para eso están los
nueve casos de oro; hay que enterarse, no taparlo.

---

## 8. El plan de migración de la finca que ya está usando la app

Nueve fases. **En ninguna de ellas existe un momento en el que un pago pueda
perderse o duplicarse**, y la razón estructural es una sola: hasta la fase 7 el
teléfono conserva su SQLite completo y correcto, y nada de lo que se hace lo
modifica de forma destructiva.

Precondición: sigue vigente la mitigación de la decisión 3 —**se paga desde un
solo lado**— hasta la fase 7. No hasta que se despliegue el sync.

**Fase 0 · Antes de tocar el teléfono.**
Arreglar §4.4 (idempotencia del ledger) y desplegarlo. Añadir `expectedGrossCents`
y `GROSS_CHANGED` (§5.5), y `EMPLOYEE_EXISTS_DELETED` (§5.6). Los tres son
cambios de servidor que no afectan a nadie hasta que alguien los use.

**Fase 1 · Una versión del teléfono que sólo añade columnas.**
`user_version = 6`: los UUID, el relleno hacia atrás, `deletedAt` en `pickups`,
`localDay`/`week` materializados, `costPerUnitCents`, `outbox`, `sync_state`.
**Sin una sola llamada de red.** La app se comporta exactamente igual.
Criterio de salida: los 75 tests del móvil y los 9 casos de oro verdes
**ejecutados sobre una copia de la base real de la finca**, no sobre una
sembrada. `missing = 0` en la consulta de §1.3.

**Fase 2 · La copia.**
Se saca una copia del `.db` del teléfono a dos sitios distintos, y se **prueba
restaurarla** en un teléfono de repuesto: se abre la app y se comparan tres
cifras contra la pantalla del original (kilos de la temporada, número de
liquidaciones vivas, saldo del trabajador con más movimientos). Nada continúa
hasta que esa restauración funciona. Una copia que nadie ha restaurado no es
una copia.

**Fase 3 · La importación, en seco.**
Contra una base de datos de prueba con las migraciones puestas, en **una sola
transacción**, conservando los UUID del teléfono:

```sql
-- Order matters: parents first, and every id is the phone's own uuid.
--  people          -> employees
--  crops           -> plots (uuid nuevo) + plot_crops (HEREDA el uuid del crop)
--  cost_overrides  -> week_prices
--  pickups         -> work_records, actividad semilla "Recolección",
--                     rate_source = 'weekly_price', unit = kg,
--                     started_at = pickups.date, quantity = weight
--  settlements     -> settlements
--  settlement_items-> settlement_items (payable_id = pickups.uuid)
--  ledger          -> ledger, en orden de id, con settlement_id y reverses_id
--                     resueltos por uuid
```

`plot_crops` hereda el uuid del `crop` porque es a donde apuntaban las pesadas;
la parcela es nueva y se llama igual que el lote que el usuario tenía en la
cabeza. Es la migración que ya describe `modelo-datos.md` §B, y su propiedad
importante es que **el dinero no se remapea**: `settlement_items.payable_id`
apunta al mismo uuid que apuntaba en el teléfono.

Y antes del `COMMIT`, tres consultas de reconciliación que **tienen que devolver
cero filas**:

```sql
-- 1. Saldo por trabajador: el del teléfono contra el del servidor.
--    Cualquier fila aquí aborta la transacción.
SELECT e.id, p.balance_cents, s.balance_minor
  FROM phone_balances p JOIN employees e ON e.id = p.uuid
  JOIN LATERAL (SELECT COALESCE(SUM(amount_minor),0) AS balance_minor
                  FROM ledger WHERE employee_id = e.id) s ON true
 WHERE p.balance_cents <> s.balance_minor;

-- 2. Kilos por semana.
SELECT week_start, SUM(quantity) FROM work_records GROUP BY 1
EXCEPT SELECT week, kg FROM phone_weeks;

-- 3. El candado: tantas líneas vivas como tenía el teléfono, ni una más.
SELECT COUNT(*) FROM settlement_items WHERE voided_at IS NULL;  -- = phone count
```

Se repite hasta que salga limpio. Todo esto ocurre sobre una copia: el teléfono
no se ha enterado de nada.

**Fase 4 · El corte, y es la única hora que importa.**
Un martes por la mañana, un día en que la finca no paga, con alguien presente:

1. La app del teléfono entra en **modo lectura de dinero** por control remoto
   (`capabilities.settleOffline = false` más un `moneyReadOnly = true` en el
   handshake, o una bandera local si aún no hay red): se pueden registrar
   pesadas, no se puede liquidar, pagar ni anular. Registrar sigue abierto
   porque el corte no puede parar la báscula.
2. Se saca una segunda copia, la de verdad, la del momento del corte.
3. Se corre la importación de la fase 3 contra producción, con las mismas tres
   consultas de reconciliación **dentro de la transacción**.
4. Si algo falla: `ROLLBACK`, se quita el modo lectura, y la finca sigue como
   estaba. **El teléfono no se ha modificado, así que no hay nada que
   deshacer.** Esa es toda la seguridad de este plan.

Duración esperada: menos de una hora para una temporada.

**Fase 5 · Sólo pull, 24 horas.**
Se enciende el `pull` y nada más. El teléfono recibe, aplica y no manda nada.
Durante esas 24 horas, el teléfono y la web están mirando lo mismo desde dos
sitios, y las pesadas nuevas del teléfono **siguen sin salir de él**, en el
outbox, esperando.

Se comparan a mano: el saldo de cinco trabajadores, los kilos de la semana, el
número de liquidaciones vivas. Aquí es donde un error se encuentra gratis,
porque todavía no se ha escrito nada en el servidor desde el teléfono.

**Fase 6 · Push.**
Se enciende el push. El outbox se vacía en orden. Se vuelve a reconciliar.
El servidor ya tiene todo lo que ocurrió durante la fase 5.

**Fase 7 · Se levanta el modo lectura y se retira el aviso.**
El teléfono vuelve a poder pagar y anular, con el botón de liquidar exigiendo
sincronización previa (§6.1). **Aquí, y sólo aquí, se retira el aviso permanente
de la web** y termina la mitigación «se paga desde un solo lado» de la
decisión 3.

**Fase 8 · Conservar.**
La copia previa a la migración se guarda toda la temporada. No se borra al día
siguiente porque un descuadre se descubre cuando alguien reclama, y eso pasa a
las tres semanas.

**Fase 9 · La fecha límite que no fijamos nosotros.**
El teléfono sigue hablando por `/v1/pickups`, que traduce `cropId → plot_crop`.
**El día que la finca registre un segundo cultivo en un lote, la fachada deja de
poder traducir.** Antes de ese día el teléfono tiene que estar en
`/v1/work-records`. No es una preferencia de calendario: es una propiedad del
modelo, y la web tiene que impedir crear el segundo cultivo en un lote mientras
haya un teléfono en `schemaVersion < 7`.

---

## 9. Lo que NO haría

- **CRDTs, automerge, o cualquier librería de merge.** El ledger ya conmuta:
  añadir es conmutativo y el saldo es un `SUM`. Una librería de CRDT no añade
  nada a eso y mete un algoritmo que nadie del equipo puede depurar entre un
  recolector y su pago.
- **Last-write-wins en cualquier fila de dinero.** No hay ni un campo del rastro
  de dinero cuya sobrescritura sea segura. Donde hace falta corregir, se anula y
  se rehace, que es la única operación que deja rastro.
- **Un replicador bidireccional genérico de tablas.** La dirección por tabla de
  §2 *es* el diseño. Un motor genérico la borra y convierte la primera
  configuración mal puesta en una fuga de nómina.
- **Relojes vectoriales, HLC, o cualquier orden distribuido.** Hay un servidor.
  Su orden de commit es un orden total. `sync-and-roles.md` proponía «contador
  por dispositivo + orden de llegada»; el `seq` con horizonte hace lo mismo con
  un entero.
- **Websockets, SSE o notificaciones push.** Sondear al abrir, al volver a
  primer plano, cada 15 minutos y al pulsar. Una conexión persistente sobre la
  red de una finca es batería y datos a cambio de una latencia que a nadie le
  importa.
- **Sincronizar nada derivado.** Saldos, IRL, anomalías, totales, ni una vez.
  Se recalculan a los dos lados desde los mismos hechos, y si difieren eso es un
  bug que los casos de oro tienen que cazar, no una fila que copiar. El único
  total que viaja es el `balances` del §3.3, y viaja **como checksum**, se
  compara y se tira.
- **Sincronizar en dos direcciones los precios y las parcelas.** §2.1.
- **Borrar físicamente algo, en cualquier dirección.** Un `DELETE` no deja
  lápida y resucita en el siguiente pull. Por eso `pickups.remove` pasa a ser
  lógico en §1.5.
- **Una pantalla de conflictos con un diff.** §7.3.
- **Sincronizar fotos en la primera versión.** Una foto de empleado son
  megabytes en el plan de datos del pesador. Sube sólo con wifi, en segundo
  plano, y **no bloquea nada**: un empleado sin foto es un empleado.
- **Cifrar la base local, un proceso de sync aparte, o un servicio nativo en
  segundo plano.** Ninguno de los tres resuelve un problema que esta finca
  tenga hoy, y los tres son código que hay que mantener sin poder probarlo.
- **Resolver automáticamente un conflicto que toque dinero.** Si la regla no
  está escrita en §5, termina delante de una persona.
- **Un modo «forzar subida» o «reiniciar sincronización» en la interfaz.** Es el
  botón que un día alguien pulsa a las once de la noche. Si hace falta un
  bootstrap, lo dispara el servidor con `CURSOR_TOO_OLD`.

---

## 10. Lo que sólo puede decidir el dueño

Cada uno de estos cambia lo que su gente puede hacer en el lote. Ninguno lo
puede firmar el equipo.

1. **El teléfono deja de liquidar sin señal** (§6). En campo se entrega
   `anticipo`, que se amortiza exacto. ¿Se acepta perder el cierre de semana en
   el lote? Si no, hay que construir la variante «provisional» de §6.4, que es
   una pantalla más y dos semanas más.
2. **Las parcelas y los cultivos pasan a ser de sólo lectura en el teléfono**
   (§2.1). ¿Quién abre un lote nuevo a mitad de cosecha, y puede esperar a que
   alguien lo cree en la web?
3. **El precio semanal pasa a ser de sólo lectura en el teléfono** (§2.1). El
   dueño lo pone en la web. ¿Le sirve?
4. **El teléfono no verá jornales ni contratos** (§2.2), así que su saldo deja
   de ser el saldo completo de quien haga las dos cosas. ¿Se acepta, o hay que
   costear la pantalla de labores en el móvil antes del sync?
5. **Un teléfono que lleva muchos días sin sincronizar: ¿se le sigue dejando
   pesar?** Recomendación: **sí, siempre**, sin límite. Pero eso significa un
   atraso sin techo y una reconciliación grande el día que baje. La alternativa
   —bloquear a los N días— para la báscula, y parar la báscula es peor.
6. **Un trabajador dado de baja con trabajo nuevo** (§5.6): ¿el
   comportamiento por defecto es volver a darlo de alta, o dejarlo de baja y
   avisar? Recomendación: dejarlo de baja y avisar, porque la baja la decidió
   alguien.
7. **Quién lee la pantalla de conflictos.** Recomendación: los de dinero, sólo
   el dueño y el administrador; al pesador sólo los suyos. Si el dueño quiere
   que el pesador los vea todos, hay que abrirle lecturas que hoy la RLS le
   niega, y eso es una decisión de privacidad de la nómina, no de sincronización.
8. **Cuándo es el corte de la fase 4** y quién está presente. Un martes por la
   mañana, menos de una hora, y no un día de pago.
