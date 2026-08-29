# Báscula — Diseño de API y autenticación (revisión 2, alcance RSP-001…033)

## 0. Invariantes heredadas del móvil (siguen intactas)

Centavos `int64`; ledger append-only (se cancela con `reverse`, no se edita); semana = **fecha ISO del lunes** (`2026-08-24`) — el comentario `"2026-W33"` en `db.ts:447` está obsoleto, `WEEK_OF` ya produce el lunes; fechas de negocio en la zona de la finca (`farms.timezone`, obligatoria); IDs `UUIDv7` generados en el cliente.

**El hallazgo que ordena toda la revisión: el ledger ya es lo bastante general y no cambia.** `devengo / pago / anticipo / deduccion / ajuste / reverso` cubre por igual una recolección de café, un jornal y un contrato de poda. Lo que se generaliza es **lo que alimenta** al ledger.

---

## 1. Tensión A — ¿pickups o labores? **Se generaliza. Un solo camino.**

Mantener dos caminos duplica lo único que no puede duplicarse: el candado anti doble pago. Hoy `ux_items_pickup_live` garantiza que una pesada pertenezca a una sola liquidación viva. Con dos tablas pagables harían falta dos candados y ninguna forma de que una liquidación los tome juntos en una transacción — un empleado que recoge café **y** hace un jornal la misma semana necesita **una** liquidación, no dos.

**Modelo:**

```
activities   (catálogo por finca)
  id, name, category(siembra|mantenimiento|cosecha),
  pay_mode(contract|time_unit|work_unit),
  time_unit(jornal|semanal|quincenal|mensual|custom) | work_unit(kg|arroba|canasta|…),
  default_rate_cents, rate_source(weekly_price|fixed), status

work_records (labores — RSP: el registro de que alguien ejecutó una actividad)
  id, worker_id, activity_id, plot_ids[], crop_ids[],
  date_from, date_to, quantity, rate_cents NULL, note, created_by
```

Una pesada es un `work_record` con `pay_mode='work_unit'`, `unit='kg'`, `date_from = date_to`, `quantity = weight`. **Nada más.**

`settlement_items.pickupId` pasa a `payable_id` (+ `payable_kind`, hoy siempre `'work_record'`, reservado para futuros pagables como bonificaciones). El índice parcial se conserva idéntico: `UNIQUE(payable_id) WHERE voided_at IS NULL`.

**El punto fino que hay que decidir hoy, no después:** cuándo se congela el precio.

| `pay_mode` | Precio | Momento |
|---|---|---|
| `work_unit` + `rate_source='weekly_price'` | `costForWeek(lunes)` | **al liquidar** (comportamiento actual, se preserva) |
| `work_unit` + `fixed`, `contract`, `time_unit` | `rate_cents` del propio registro | **al escribir**, congelado |

Corolario obligatorio: un `work_record` con `rate_source='weekly_price'` **debe ser de un solo día** (`date_from = date_to`). Un jornal de martes a martes no tiene "una" semana, y derivar precio semanal sobre un rango es la clase de ambigüedad que termina en un pago mal calculado. Los rangos son legítimos solo con precio congelado.

**Coste de migración, concreto:**
- **Móvil: cero en la entrega 1.** `/v1/pickups` sobrevive como fachada delgada sobre `work_records` (POST crea con la actividad semilla "Recolección"; GET filtra `pay_mode='work_unit'`). El móvil no se toca.
- **Servidor: 3–5 días de un dev.** El SQL portado (`PENDING_SQL`, `INDEX_SQL`, `WEEK_*_SQL`, las reglas de anomalías) no se reescribe: se le añade `WHERE a.pay_mode = 'work_unit'`. El índice comparativo y las reglas de anomalías **solo tienen sentido por unidad de trabajo** — comparar jornales por productividad no significa nada —, así que ese filtro es correcto, no un apaño.
- **Móvil, entrega 2:** ~2 semanas para pasar a `/v1/work-records` y ganar labores. `/v1/pickups` se deprecia pero no se elimina mientras haya un teléfono viejo en una finca, y siempre lo hay.

---

## 2. Tensión C — SIG: **PostGIS desde el inicio.**

Un polígono en `jsonb` es un adorno: no valida, no calcula y no responde nada. En cuanto alguien pregunte "¿cuántas ha tiene este lote realmente?" o "¿esta parcela se solapa con la vecina?", hay que reescribir cada consulta *y* rellenar los datos hacia atrás. PostGIS es una extensión disponible en RDS, Cloud SQL y Supabase; el coste de adoptarla es una línea de migración.

```sql
plots (
  id uuid, farm_id uuid, name text, department text, municipality text,
  area_ha numeric(10,4),                    -- lo que declara el dueño
  boundary geography(Polygon, 4326),        -- lo que dibujó en el mapa
  status text CHECK (status IN ('active','inactive'))
)
```

Se usan **tres** funciones y ninguna más: `ST_IsValid` (rechazar polígonos que se cruzan a sí mismos, `400 INVALID_GEOMETRY`), `ST_Area(boundary)/10000` (hectáreas calculadas) y `ST_Intersects` (avisar de solapes entre lotes). `area_ha` declarada y `computedAreaHa` se devuelven **las dos**: discrepan siempre, y ocultar una de ellas es decidir por el dueño cuál miente. En la frontera HTTP todo viaja como **GeoJSON**, así que la web y el móvil nunca ven PostGIS. No se construye un producto SIG.

---

## 3. Tensión B — Historial cross-tenant (RSP-004, RSP-009)

**Esto no es un endpoint más. Es un producto distinto, con riesgo legal propio, y hay que decirlo antes de codearlo.**

Búsqueda por cédula + "alertas de seguridad" + varias fincas consultando = una **lista negra laboral de facto**. En Colombia eso cae bajo la Ley 1581 de 2012 (habeas data): tratamiento de datos personales sin autorización, sin finalidad declarada, sin derecho de rectificación. Un texto libre que diga "este señor es problemático" es difamación distribuida, no verificable y no contestable, y hunde a una persona en toda una región sin que se entere.

**Diseño: servicio aparte, `registry`, esquema propio, credenciales propias, sin acceso al schema de las fincas. Nunca una tabla más dentro del tenant.**

```
POST /registry/v1/lookups
  {documentType, documentNumber, purpose:"hiring"}
  -> { verified: true,
       farmsWorked: 3,
       employmentSpans:[{from:"2024-01",to:"2024-06"}],   -- meses, no días
       disputes: 0,
       consentOnFile: true }
GET  /registry/v1/workers/{docHash}/lookups     -- quién me consultó (para el trabajador)
POST /registry/v1/consents                      -- alta explícita, revocable
POST /registry/v1/disputes                      -- derecho de réplica
```

**Se comparte:** que la cédula existe y está verificada; **cuántas** fincas y en qué meses; si hay disputas abiertas. **Jamás se comparte:** nombres de las fincas, saldos, deudas, anticipos, montos, kilos, productividad, anotaciones libres, fotos, teléfono, dirección. Ni siquiera al super-admin.

Reglas duras: (1) **sin consentimiento registrado del trabajador, `lookup` devuelve `403 NO_CONSENT`** y nada más; (2) toda consulta deja rastro con `farm_id`, usuario y `purpose`, y **el trabajador puede leer ese rastro** — esa es la mitad de RSP-009 que sí vale la pena construir; (3) participación **opt-in por finca**, y el opt-out no borra el historial ajeno pero corta el aporte.

**Recomendación explícita al dueño: las "alertas de seguridad" de texto libre no se construyen en la entrega 1, y probablemente nunca en esa forma.** Si insiste, la única versión defendible es: hecho estructurado de un catálogo cerrado, atribuido a una finca identificable, notificado al trabajador, disputable, y con caducidad automática a 24 meses. Sin esas cinco propiedades es un arma. La entrega 1 construye el **log de consultas** (barato, útil, sin riesgo) y deja el resto detrás de un flag apagado.

---

## 4. Estructura Go (sin cambios de fondo, dos paquetes más)

`chi` + `pgx/v5` + `sqlc` + `goose`, por lo mismo de antes: el dominio es contable y hay que portar `BALANCE_SQL`/`PENDING_SQL` *literalmente*; GORM sobre un libro contable queda descartado. Layout plano en `internal/`: `httpapi`, `domain`, `store`, `auth`, `tenant`, **`+ media`** (subidas), **`+ registry`** (el servicio cross-tenant, compilable como binario aparte desde el día 1 aunque de momento se despliegue junto). Tests con `testcontainers` y Postgres+PostGIS reales.

**Fotos (empleado 5 MB, comprobante de venta): nunca en Postgres.** Object storage con subida por URL prefirmada.
```
POST /v1/media/uploads {kind:"worker_photo"|"sale_receipt", contentType, sizeBytes}
  -> {mediaId, uploadUrl, expiresIn}   ; el cliente sube directo y luego referencia mediaId
```
Límite 5 MB validado en el servidor al confirmar, no solo en el prefirmado.

---

## 5. Contrato REST. Base `/v1`, tenant en el token. `M`=móvil, `W`=web.

**Auth y alta de finca** — aquí hay un choque con la revisión anterior: el documento pide **auto-registro** en su sección sin numerar y el diseño previo daba el alta solo al super-admin. Se resuelve con las dos puertas, y la finca nueva queda activa tras verificar el correo (ver `docs/decisiones.md`):
```
POST /v1/signup {farm:{name,timezone}, owner:{email,name,password}}   público, rate-limited
POST /v1/auth/login · /auth/refresh · /auth/logout · GET /v1/me        M W
GET|POST /v1/admin/farms · PATCH /v1/admin/farms/{id} {status}         W  (super-admin)
```

**Parcelas y cultivos** (M lee, W escribe)
```
GET|POST /v1/plots · GET|PATCH /v1/plots/{id}            baja lógica: PATCH {status:"inactive"}
PUT      /v1/plots/{id}/boundary   {geojson}             400 INVALID_GEOMETRY
GET|POST /v1/plots/{id}/crops      {cropTypeId,varietyId,plantedAt,areaHa}
GET|POST /v1/catalogs/crop-types · /v1/catalogs/varieties · /v1/catalogs/units
```
Los catálogos resuelven el "si no existe, botón para agregarlo": `POST` con `{name}` es idempotente por `(farm_id, lower(name))` y devuelve `200` con el existente. El autocompletar nunca duplica.

**Empleados** (M W)
```
GET|POST /v1/workers · GET|PATCH /v1/workers/{id} · DELETE (baja lógica)
GET /v1/workers/{id}/profile   -> saldo + últimos movimientos + labores + anotaciones
GET|POST /v1/workers/{id}/notes                       anotaciones, append-only
```

**Actividades y labores** (M W)
```
GET|POST|PATCH /v1/activities?category=            precios: solo owner
GET|POST /v1/work-records?workerId&plotId&from&to
PATCH|DELETE /v1/work-records/{id}                 409 WORK_RECORD_SETTLED
GET|POST|PATCH|DELETE /v1/pickups                  fachada legacy sobre work_records   M
```

**Liquidaciones y dinero** — sin cambios salvo que `pickupIds` pasa a `payableIds`:
```
POST /v1/settlements/preview · POST /v1/settlements {payableIds[]} · GET /v1/settlements/{id}
POST /v1/settlements/{id}/void
POST /v1/payments · /advances · /deductions · /adjustments · /ledger/{id}/reverse · /payroll/undo
GET  /v1/balances · /v1/workers/{id}/balance · /v1/workers/{id}/ledger · /v1/pending · /v1/farm/totals
```

**Inventario, ventas, gastos** (W; el móvil solo lee existencias)
```
GET|POST /v1/products · /v1/warehouses · /v1/product-categories
GET      /v1/stock?warehouseId&cropId&plotId          existencias derivadas, nunca escritas
POST     /v1/stock-movements {productId,warehouseId,qty,unit,reason,plotId,cropId}
POST     /v1/labels/print     {productId,qty}  -> PDF/ZPL de stickers
GET|POST /v1/sales    {productId,qty,customer,amountCents,receiptMediaId}
GET|POST /v1/expenses {amountCents,scope:"activity"|"plot_crop",activityId|plotId,cropId,note}
```
**Las existencias se derivan de los movimientos**, igual que el saldo se deriva del ledger. Misma disciplina, mismo motivo: un total almacenado es un total que algún día miente.

**Configuración y usuarios**: `GET|PUT /v1/config`, `GET|PUT /v1/prices/weeks/{monday}`, `GET|POST|PATCH /v1/users` (owner).

---

## 6. Autorización — el weigher, ahora con más superficie que negar

JWT de acceso 15 min (claims `sub, farm_id, role, device_id, jti`) + refresh opaco de 60 días en Postgres, con rotación y detección de reuso: el móvil está días sin señal y un teléfono prestado tiene que poder matarse desde la web. **El tenant viaja en el token, nunca en la ruta** — un `farmId` en el path invita a que alguien confíe en él. Middleware: `Auth → Tenant (SET LOCAL app.farm_id, RLS activa en toda tabla) → Require(action)`, con los permisos en **una tabla Go**, no en `if`s por handler.

El alcance nuevo multiplica lo que el weigher no debe ver. Su lista blanca completa es: `POST /v1/work-records` (solo actividades `work_unit`), `GET` de sus propios registros (RLS por `created_by = sub`), y lectura mínima de workers (`id,name,lastName,tag` — sin documento, sin teléfono, sin foto), plots y crops. **403 en middleware** para todo lo demás, incluidos los módulos nuevos: `/activities` con precios, `/sales`, `/expenses`, `/stock*`, `/workers/{id}/profile`, `/workers/{id}/notes`, `/registry/*` y `/users`. `GET /v1/config` le llega sin `costPerUnitCents`; `GET /v1/activities` sin `default_rate_cents`.

Un test de contrato recorre la tabla de rutas y afirma 403 para weigher en toda ruta de dinero, personas o registry; **una ruta nueva sin entrada en la tabla hace fallar el build**. Con nueve módulos, eso deja de ser higiene y pasa a ser la única defensa que escala.

---

## 7. `packages/shared` y errores

En `shared` solo lo que si diverge cuesta dinero: enums (`LedgerKind`, `PayMethod`, `Role`, **`PayMode`**, **`ActivityCategory`**, **`StockReason`**), los DTO de dinero, y cuatro reglas puras (`mondayOf`, `toCents/fromCents`, signos por `kind`, `amountCents(qty, rate)`). **`openapi.yaml` es la fuente de verdad**: `oapi-codegen` para Go, `openapi-typescript` para web y móvil, regenerado en CI con build rojo si el diff no está commiteado. Las reglas puras se escriben dos veces (~40 líneas) y se atan con un fixture JSON compartido que ambas suites recorren — redondeo y semanas ISO es justo donde dos lenguajes divergen en silencio.

Errores: `{"error":{"code","message","details"}}`; el cliente ramifica por `code`, la traducción vive en el cliente. Los conflictos de negocio son **409 con código propio y son parte del contrato**: `WORK_RECORD_SETTLED`, `PAYABLE_ALREADY_CLAIMED` (con `details.winningSettlement` completo para que el móvil re-derive), `SETTLEMENT_ALREADY_VOID`, `ALREADY_REVERSED`, `NOTHING_TO_SETTLE`, `FARM_SUSPENDED`, y nuevos: `INSUFFICIENT_STOCK`, `INVALID_GEOMETRY`, `PLOT_HAS_ACTIVE_CROPS` (baja lógica bloqueada), `NO_CONSENT` (registry). Toda escritura acepta `id` del cliente y es idempotente por `(farm_id, id)`: reintentar tras un timeout devuelve `200` con el recurso existente, no `409`.

---

## 8. Lo que NO haría ahora

- **Sync offline.** Igual que antes: se construye contra reglas ya cerradas. Entrega 1 = móvil online.
- **Reescribir el móvil a labores.** La fachada `/v1/pickups` existe justo para no bloquearlo.
- **Las "alertas de seguridad" cross-tenant.** Ver §3. Se construye el log de consultas; el resto queda tras un flag apagado y una conversación con el dueño.
- **Inventario con costeo (PEPS/promedio), trazabilidad de lotes, conciliación de ventas.** Entrega 1: existencias y movimientos. El costeo es un proyecto propio.
- **Impresión de stickers desde el servidor con plantillas configurables.** Un PDF de tamaño fijo. La plantilla configurable llega cuando alguien se queje del tamaño.
- **Reportes de rendimiento y anomalías en el servidor.** Ya funcionan y están probados en el móvil; portar ese SQL delicado ahora duplica riesgo por una web que aún no existe.
- **GraphQL, gRPC, microservicios, CQRS, permisos configurables, 2FA, SSO.** Un binario (dos con `registry`), un Postgres, cuatro roles hardcodeados.
- **UI de super-admin.** El auto-registro la vuelve casi innecesaria.

**Primer sprint:** dev A → migraciones + PostGIS + RLS + auth/signup + workers + plots/crops + catálogos. Dev B → `domain`: generalizar `payable`, portar `PENDING_SQL`/`BALANCE_SQL`, `settle/void/reverse`, actividades y labores, con tests contra Postgres real. Se encuentran en `openapi.yaml`, que se escribe el primer día antes que cualquier handler. `registry`, ventas, gastos e inventario entran en el sprint 2.


---

# Báscula — Entrega 2: generalización, módulos nuevos y servicios cruzados

## 0. La migración que nadie ha costeado todavía

Antes de la generalización de labores hay una anterior y más barata de hacer ahora que dentro de seis meses: **la tensión 2 del documento**. Hoy `crops` mezcla parcela y cultivo (`name, type, variety, dimension`) y `pickups.cropId` apunta ahí — es decir, la pesada de café hoy cuelga de algo que es *el lote*, no *el cultivo*. RSP-001 los separa: una parcela tiene superficie, ubicación y polígono, y **varios** cultivos con tipo y variedad.

La partición es 1:1 y sin pérdida, y por eso hay que hacerla ya:

```
crops(id, name, type, variety, dimension)
  → plots(id, name, area_ha := dimension, department, municipality, boundary NULL)
  + plot_crops(id, plot_id, crop_type_id := catálogo(type), variety_id := catálogo(variety))
  ; pickups.cropId → tasks.plot_crop_id   (mapeo determinista, una fila por una)
```

Mientras sea 1:1, la fachada de compatibilidad del móvil puede mentir perfectamente: `POST /v1/pickups {cropId}` resuelve al `plot_crop` generado. En cuanto una finca registre el segundo cultivo en un lote, deja de ser 1:1 y la fachada ya no puede inventar cuál era. **Ventana: hasta que la web permita añadir cultivos.** Esa es la fecha límite real de la migración del móvil, no una preferencia.

---

## 1. Generalización: `/v1/tasks` manda, `/v1/pickups` sobrevive como atajo

**Recomendación: un solo camino. `tasks` (labores) es la entidad pagable; la recolección por kilos es una `task` de una actividad con `pay_mode='work_unit'`, `unit='kg'`, `date_from = date_to`.**

El argumento decisivo no es la elegancia, es **RSP-008**: la pantalla de pago que el dueño describe muestra *una* lista de labores, *una* de deudas y *un* "Total a pagar". Dos tablas pagables conviviendo obligan a dos candados anti doble pago (`ux_items_pickup_live` duplicado) y hacen imposible que un empleado que recolectó café **y** hizo tala por jornal la misma semana reciba **una** liquidación. El propio documento del dueño exige un único flujo de pagables.

```
activities   id, farm_id, name, category_id, pay_mode(contract|time_unit|work_unit),
             unit_id NULL, time_unit(jornal|semanal|quincenal|mensual|custom) NULL,
             custom_qty NULL, custom_period(dia|mes|ano) NULL,
             default_rate_cents, rate_source(fixed|weekly_price), status
tasks        id, farm_id, activity_id, worker_id, date_from, date_to,
             quantity numeric, rate_cents NULL, rate_source, note, status, created_by
task_plots   (task_id, plot_id)          -- RSP-015: lotes en plural, obligatorio
task_crops   (task_id, plot_crop_id)     -- RSP-015: cultivos en plural, obligatorio
```

`settlement_items.pickup_id` pasa a `payable_id` → `tasks.id`, con el índice parcial idéntico. **El ledger no cambia ni una línea:** `devengo` describe igual de bien una recolección, un jornal y un contrato. Ese es el hallazgo tranquilizador de toda la entrega.

**Precio, y la regla que hay que cerrar hoy.** `amount_cents = round(quantity × rate_cents)` — la misma regla que ya usa el móvil (`Math.round(weight * costPerUnitCents)`), ahora válida para los tres modos: `contract` (quantity=1), `time_unit` (quantity = nº de jornales), `work_unit` (quantity = kg/arrobas/canastas). Pero conviven dos momentos de congelación:

| | precio | congelado |
|---|---|---|
| `work_unit` + `weekly_price` | `costForWeek(lunes)` | **al liquidar** (comportamiento actual, intacto) |
| todo lo demás | `rate_cents` de la propia labor, por defecto el de la actividad (RSP-015) | **al escribir** |

Y de ahí una restricción obligatoria: **`rate_source='weekly_price'` exige `date_from = date_to`**. RSP-015 admite rangos de fechas; un jornal de martes a martes no tiene un único lunes y derivar precio semanal sobre un rango es exactamente la ambigüedad que termina en un pago mal calculado. Rangos sí, pero con precio congelado. Un `CHECK` en la tabla, no una convención.

**Coste de migración:**
- **Móvil en producción: cero en esta entrega.** `/v1/pickups` se mantiene como fachada delgada (POST crea una `task` de la actividad semilla "Recolección por kilos" con un `plot_crop`; GET filtra `pay_mode='work_unit'`). No se toca el teléfono de nadie a mitad de cosecha.
- **Servidor: ~1 semana de un dev**, de las cuales la mitad es el split `crops → plots + plot_crops`. El SQL portado (`PENDING_SQL`, `BALANCE_SQL`, `INDEX_SQL`, `WEEK_*`, reglas de anomalías) **no se reescribe**: se le añade `JOIN activities a ... WHERE a.pay_mode='work_unit'`. Índice comparativo y detección de anomalías solo tienen sentido por unidad de trabajo — comparar productividad entre jornales no significa nada —, así que ese filtro es la semántica correcta, no un apaño.
- **Móvil, entrega siguiente: ~2 semanas** para pasar a `/v1/tasks` y ganar labores en el campo. `/v1/pickups` se deprecia y no se elimina mientras haya un teléfono viejo en una finca; siempre lo hay.

---

## 2. Endpoints nuevos

Rol mínimo: `wei` (weigher o superior) · `adm` (administrator o superior) · `own` (solo owner). `M`=móvil, `W`=web, `R`=lectura.

**Catálogos** — resuelven el "con opción de agregar si no existe" de RSP-001/011/019. `POST` idempotente por `(farm_id, lower(name))`: devuelve `200` con el existente, nunca duplica.
```
GET|POST /v1/catalogs/{crop-types|varieties|activity-categories|work-units|
                       time-units|product-categories|storage-units|customers}   W adm
```

**Parcelas** (RSP-001…003) — cultivos anidados, porque el formulario es uno solo
```
GET  /v1/plots?status=active                                            M W R  wei
POST /v1/plots  {id,name,areaHa,department,municipality,
                 boundary:GeoJSON|null,
                 crops:[{id,cropTypeId,varietyId}]}                     W      adm
GET  /v1/plots/{id}                        -> incluye crops[] y computedAreaHa  wei
PATCH /v1/plots/{id}                       body idéntico, sustituye crops[]     adm
DELETE /v1/plots/{id}                      -> status='inactive'                 adm
POST|DELETE /v1/plots/{id}/crops[/{cropId}]                             W      adm
```
`areaHa` (declarada) y `computedAreaHa` (`ST_Area` del polígono) se devuelven **las dos**. Discrepan siempre; elegir cuál mostrar es decisión del dueño, no del servidor.

**Empleados** (RSP-004…008) — el perfil de RSP-007 en una llamada
```
GET  /v1/workers/{id}/profile   -> worker + balance + tasks[] + ledger[] + notes[]   W adm
GET|POST /v1/workers/{id}/notes  {text}      append-only, visibilidad por defecto private   adm
GET  /v1/workers/{id}/payables  -> {tasks:[{activity,date,plots,amountCents}],
                                    debts:[...], totalCents}    ← la pantalla de RSP-008   adm
GET  /v1/payments/{id}/receipt  -> PDF                          ← "recibo de pago"         adm
POST /v1/media/uploads {kind:"worker_photo"|"sale_receipt",contentType,sizeBytes}
                                 -> {mediaId,uploadUrl}   5 MB validado al confirmar       adm
```
Pago parcial y total de RSP-008 **no necesitan endpoints nuevos**: son `POST /v1/payments` con `amountCents < balance` o `= balance`. La validación "menor al saldo actual" se hace en servidor contra el balance derivado, con `409 AMOUNT_EXCEEDS_BALANCE`. Nada de un flag `isFullPayment` que se desincronice.

**Actividades** (RSP-010…013)
```
GET  /v1/activities?category=&q=        agrupadas por categoría                  M W R  wei*
POST|PATCH /v1/activities                                                        W      adm
PATCH /v1/activities/{id} {status:"inactive"}                                    W      adm
PUT  /v1/activities/{id}/rate {rateCents}                                        W      own
```
`wei*`: el weigher recibe la lista **sin** `defaultRateCents` ni `rateSource`. Proyección distinta, misma ruta.

**Labores** (RSP-014…017)
```
GET  /v1/tasks?workerId&plotId&activityId&from&to&status                M W R  wei (solo propias)
POST /v1/tasks {id,activityId,workerId,quantity,rateCents?,
                dateFrom,dateTo,plotIds[],plotCropIds[],note}           M W    wei (solo work_unit)
PATCH|DELETE /v1/tasks/{id}      409 TASK_SETTLED   ·  DELETE = inactive        adm
GET|POST|PATCH|DELETE /v1/pickups[...]      fachada legacy sobre tasks   M      wei
```

**Productos e inventario** (RSP-018…025)
```
GET|POST /v1/products {id,name,categoryId,storageUnitId}                W      adm
PATCH /v1/products/{id} {status:"inactive"}                             W      adm
GET  /v1/inventory?productId&plotId&warehouse   -> existencias derivadas  M W R wei
POST /v1/inventory/entries {id,productId,quantity,plotId,
                            plotCropId,warehouse?}  -> {entry, labelBatchId}     adm
GET  /v1/labels/{labelBatchId}  -> PDF de stickers                       W      adm
```
**Las existencias se derivan de los movimientos, nunca se almacenan ni se escriben**, exactamente por el mismo motivo que el saldo se deriva del ledger: un total guardado es un total que algún día miente. RSP-025 dice "al guardar imprime los stickers"; el servidor **no imprime**, genera el lote de etiquetas y devuelve su id — imprimir es del cliente.

**Ventas y gastos** (RSP-026…032)
```
GET|POST /v1/sales    {id,productId,quantity,amountCents,customerId,receiptMediaId}  W adm
GET|POST /v1/expenses {id,amountCents,scope:"activity"|"plot_crop",
                       activityId?|plotId+plotCropIds[],note}                        W adm
PATCH /v1/{sales|expenses}/{id} {status:"inactive"}                                  W adm
```
**Ambigüedad que hay que devolverle al dueño:** RSP-030 llama "gasto" al coste de una actividad, y RSP-008 llama "deuda" a lo que un empleado le debe a la finca. **No son lo mismo y no pueden compartir tabla.** Un `expense` es contabilidad de la finca y **jamás toca el ledger del trabajador**; una "deuda" de RSP-007/008 es un `deduccion` en el ledger. Si se mezclan, registrar el gasto de una fumigación descontaría plata del sueldo de alguien. Aquí van separados, a propósito.

**Configuración**
```
GET|PUT /v1/farm {name,phone,areaHa,country,city,address,timezone,currency}   W  own
GET|POST|PATCH /v1/users                                                       W  own
```
"Definir precios de trabajo" y "Gestión de usuarios" están marcados *pendiente de especificar* en el documento. Se entrega el mínimo que desbloquea (`PUT /v1/activities/{id}/rate` y alta de usuario con rol) y se deja escrita la pregunta al dueño: **¿el precio de una actividad tiene historial con vigencia por fechas, como ya lo tiene el precio semanal de la recolección?** Si la respuesta es sí, es una tabla más y hay que saberlo antes de codear, no después.

---

## 3. Servicio cross-tenant (RSP-004, RSP-009)

**No rompe la regla del tenant en el token: la elude por diseño.** El registro es un **servicio aparte**, esquema propio, credenciales propias, sin acceso al schema de las fincas y sin ninguna ruta que devuelva una fila de un tenant. El token de finca se intercambia por uno con `aud: "registry"`; ahí el `farm_id` **no autoriza a leer nada** — es el sujeto del log de auditoría y la clave de la cuota. La clave de búsqueda es la cédula, un espacio de nombres global, no un tenant.

```
POST /registry/v1/lookups
  {documentType, documentNumber, purpose:"hiring", authorizationRef}
  -> {found, farmsWorked:3,
      employmentSpans:[{from:"2024-01", to:"2024-06"}],   -- meses, nunca días
      openDisputes:0, claims:[]}                          -- vacío mientras el flag esté apagado
GET  /registry/v1/lookups/{id}            -- resultado asíncrono, para el caso sin internet
GET  /registry/v1/subjects/{docHash}/access-log    -- quién me consultó (lo lee el trabajador)
POST /registry/v1/disputes {recordId, reason}
```

**Público:** que la cédula existe y está verificada, **cuántas** fincas, en qué **meses**, y si hay disputas abiertas. **Nunca, ni al super-admin:** nombre de las fincas, saldos, deudas, anticipos, montos, kilos, productividad, labores concretas, teléfono, dirección, foto. La proyección es fija en código, no configurable — un campo configurable acaba encendido.

**Quién llama:** solo `owner`/`administrator` de una finca activa que haya hecho opt-in explícito, con cuota (p. ej. 50/día) y `authorizationRef`: la finca **declara** que tiene la autorización escrita del candidato. Sin ese campo, `403 NO_AUTHORIZATION`. Es lo que la Ley 1581 de 2012 exige de todos modos, y convierte una consulta silenciosa en un acto atribuible.

**Se registra siempre** (RSP-009 lo pide como postcondición): `farm_id`, usuario, `purpose`, timestamp, resultado sí/no. Y —esta es la mitad que de verdad protege— **el trabajador puede leerlo**. Cuando alguien queda registrado como empleado, se le notifica quién lo consultó antes de contratarlo.

**Sin internet** (RSP-004): `POST /v1/workers` acepta el alta y encola la consulta; `GET /v1/workers/{id}/background-check` devuelve `pending|ready`. **La consulta nunca bloquea el alta del empleado.** Un servicio caído no puede impedir que alguien empiece a trabajar.

### La advertencia, para que el dueño decida con los ojos abiertos

RSP-009 incluye entre los "datos públicos" **las anotaciones realizadas**. Ahí está la lista negra, literal. Las anotaciones de RSP-007 son texto libre que una finca escribe sobre una persona; publicarlas por cédula a cualquier otra finca produce un expediente difamatorio, distribuido, no verificable y que la persona no sabe que existe. Con eso, un capataz enfadado deja a alguien sin trabajo en toda la región, y la plataforma es la responsable solidaria.

**Recomendación operativa:** las anotaciones nacen con `visibility='private'` y **no salen de la finca, nunca**. Compartir un hecho es un tipo distinto de registro (`shared_claim`) que solo se construye si el dueño lo pide, y solo con las cinco propiedades juntas: **(1)** hecho de un catálogo cerrado y verificable, no texto libre; **(2)** atribuido a una finca identificable ante el trabajador; **(3)** notificado a la persona al publicarse; **(4)** disputable, y una disputa lo **oculta de las consultas mientras se resuelve** —falla cerrado: una acusación en duda no circula—, con 15 días para sustanciarla o se retira; **(5)** caducidad automática a 24 meses.

Sin las cinco, es un arma. **Entrega 2 construye solo los períodos de empleo y el log de consultas** —baratos, útiles, defendibles— y deja `claims` devolviendo `[]` detrás de un flag apagado. Encenderlo es una decisión del dueño, tomada por escrito, no un `if` que alguien activa un martes.

---

## 4. Polígonos: **PostGIS desde el inicio**

Un polígono en `jsonb` es un adorno: no valida, no calcula y no responde preguntas. El día que alguien pregunte "¿cuántas hectáreas tiene de verdad este lote?" o "¿este lote se solapa con el vecino?", hay que reescribir cada consulta *y* rellenar los datos hacia atrás con polígonos que quizá ya no sean válidos. PostGIS es una extensión disponible en RDS, Cloud SQL y Supabase; adoptarla cuesta una línea de migración (`geography(Polygon,4326)`) y se usan **tres** funciones y ninguna más: `ST_IsValid` (rechazar polígonos que se cruzan solos, `400 INVALID_GEOMETRY`), `ST_Area/10000` (las hectáreas calculadas que RSP-001 acabará necesitando junto a las declaradas) y `ST_Intersects` (avisar de solapes). En la frontera HTTP todo entra y sale como **GeoJSON**, así que la web y el móvil nunca ven PostGIS y cambiar de motor sigue siendo posible. No se construye un producto SIG; se construye la capacidad de responder tres preguntas.

---

## 5. Catálogo público (RSP-010, RSP-018): **servicio aparte, y se importa por copia, no por referencia**

Es un servicio global de solo lectura —`GET /catalog/v1/activities?since=` y `/catalog/v1/products?since=`, versionado por snapshot, cacheable, sin auth— y **no** un esquema compartido dentro de la API multi-tenant: mezclar una tabla global sin `farm_id` con RLS activa es justo la excepción que un día alguien copia mal.

La decisión importante no es dónde vive, sino **cómo entra**: `POST /v1/activities/import {catalogIds[]}` **copia** las filas a las tablas de la finca y guarda `source_catalog_id` solo como procedencia. Nunca una clave foránea que cruce la frontera. Motivo: si una actividad de la finca *referencia* el catálogo global, el día que alguien renombre "Recolección por kilos" o cambie su unidad, cambia bajo labores ya liquidadas — un dato que decide dinero mutando desde fuera y sin auditoría. Copiar también hace que la finca siga funcionando cuando el catálogo esté caído, que es siempre la mitad de la temporada.
