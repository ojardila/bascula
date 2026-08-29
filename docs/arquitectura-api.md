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

**Auth y alta de finca** — aquí hay un choque con la revisión anterior: RSP-033 pide **auto-registro** y el diseño previo daba el alta solo al super-admin. Se resuelve con las dos puertas, y la finca nueva nace `status='trial'`:
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
- **UI de super-admin.** El auto-registro (RSP-033) la vuelve casi innecesaria.

**Primer sprint:** dev A → migraciones + PostGIS + RLS + auth/signup + workers + plots/crops + catálogos. Dev B → `domain`: generalizar `payable`, portar `PENDING_SQL`/`BALANCE_SQL`, `settle/void/reverse`, actividades y labores, con tests contra Postgres real. Se encuentran en `openapi.yaml`, que se escribe el primer día antes que cualquier handler. `registry`, ventas, gastos e inventario entran en el sprint 2.
