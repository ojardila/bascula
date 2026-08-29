# La simplificación que propuso el dueño

> «¿Crees que nos estamos complicando con ese modelo sync? ¿No será mejor
> manejar balances solo con lo que hay en web y solo registrar recolecciones de
> cosecha async?»

Es decir: **el teléfono deja de ser dueño del dinero.** Captura pesadas y las
sube; saldos, liquidaciones, pagos y el libro viven sólo en el servidor.

Este documento no opina sobre si eso «es más limpio». Cuenta qué se borra, qué
se pierde, qué hallazgos de la auditoría desaparecen, cómo se muda la finca real
y qué costaría la alternativa. Las cifras están medidas sobre `master` en
`b539d08`, no estimadas.

Nota de estado al escribir esto: `master` está verde (189/189 pruebas del móvil,
85/85 de `packages/shared`, 334/334 de la web). El árbol de trabajo tiene
cambios sin confirmar de otra pareja en `schema.ts` y `sqliteRepository.ts` que
rompen 4 pruebas —falta importar `BALANCE_COLUMNS` en
`apps/mobile/src/data/sqliteRepository.ts`—. No es de este documento, pero
conviene que lo sepan.

---

## 0. Por qué la propuesta es más fuerte de lo que parece, con los ficheros delante

La decisión 5 del dueño ya le quitó al teléfono la autoridad sobre el dinero: el
cierre de semana se hace con señal, contra el servidor, y el efectivo del lote es
un **anticipo**. Lo que quedó en el código después de esa decisión es
contradictorio, y no es una sospecha — es lo que ejecuta hoy:

1. `apps/mobile/src/screens/PayWorker.tsx:131` llama a `payments.settle`, que
   escribe `settlements`, `settlement_items` y el `devengo` en el SQLite del
   teléfono.
2. Los disparadores del outbox (`apps/mobile/src/schema.ts`,
   `outboxTriggersSql` sobre `SYNCED_TABLES`, que incluye `settlements` y
   `settlement_items`) encolan esas filas.
3. `apps/mobile/src/sync/engine.ts:421-426` las envía como `readOnlyEnvelope`.
4. `services/api/internal/httpapi/handlers_sync.go:402-406` las **rechaza**:
   *«settlements are created by POST /v1/settlements»*.
5. El `devengo` ni siquiera sale: `apps/mobile/src/sync/restTransport.ts:475` lo
   marca `unsendable` / `SERVER_OWNED`.
6. **Pero el `pago` sí sale**, por `/v1/payments` con `allowOverpayment: true`
   (`restTransport.ts:458` y `:496`).

El resultado, a partir de la fase 6 de `sincronizacion.md` §8: el servidor recibe
un pago sin el devengo que lo justifica, **y las pesadas siguen sin reclamar en
`ux_items_payable_live`**, así que la web puede liquidarlas otra vez y pagarlas
otra vez. Es el doble pago que todo el diseño existe para impedir, entrando por
la puerta que la decisión 5 dejó a medio cerrar. Hoy no está vivo sólo porque
sigue en pie la mitigación de la decisión 3 —«se paga desde un solo lado»—. El
día que se retire, lo está.

Y hay dos agujeros más en el mismo sitio, que ninguna de las dos opciones puede
dejar como está:

- **La nómina de cuadrilla no tiene ninguna guarda de sincronización.**
  `PayWorker.tsx:112` sí exige un pull fresco (`settleAllowed = !status.registered || fresh`).
  `PaymentsPanel.tsx:141` llama a `Payments.runPayroll` **sin comprobar nada**.
  La regla de §6.1 protege la ruta de un trabajador y deja abierta la de treinta.
- **`capabilities.settleOffline` se decodifica y se tira.** Los dos transportes
  lo parsean (`restTransport.ts:248`, `feedTransport.ts:167`) y **ninguna
  pantalla lo lee**. El «modo lectura de dinero por control remoto» que la fase 4
  de §8 da por hecho no existe.

La propuesta del dueño es, en el fondo, señalar que construimos la
sincronización bidireccional de dinero **antes** de la decisión 5 y nunca
volvimos a quitar lo que dejó de hacer falta.

---

## 1. Qué se borra exactamente, y qué se queda

### 1.1 Lo que se borra — código de aplicación

Rangos de línea sobre `b539d08`.

| Fichero | Qué | Líneas |
|---|---|---|
| `apps/mobile/src/data/sqliteRepository.ts` | `pendingItems` 1108‑1136 (29) · `reverseHere` 1170‑1197 (28) · `voidSettlementHere` 1199‑1256 (58) | 115 |
| ídem, dentro de `payments` | `preview` 1260‑1275 (16) · `settle` 1276‑1330 (55) · `voidSettlement` 1331‑1344 (14) · `runPayroll` 1345‑1401 (57) · `pay` 1402‑1415 (14) · `adjust` 1448‑1464 (17) · `reverse` 1465‑1495 (31) · `undoRun` 1496‑1526 (31) · `paidAgainst` 1606‑1609 (4) · `paidInRange` 1610‑1617 (8) · `pendingAll` 1637‑1689 (53) | 300 |
| ídem | `balance` / `balances` / `fullBalance` 1527‑1597 (71) se reescriben a ~25 | −46 |
| `apps/mobile/src/schema.ts` | `BALANCE_SQL` 126‑160 (35 → ~6) · `PAID_AGAINST_SQL` 161‑187 (27) · `PAID_IN_RANGE_SQL` 188‑196 (9) · `PENDING_SQL` 197‑212 (16) · `ux_items_pickup_live` dentro de `PAYMENTS_SCHEMA` (4) | 85 |
| `apps/mobile/src/data/syncStore.ts` | `applySettlement` 399‑480 | 82 |
| `apps/mobile/src/sync/engine.ts` | `checkBalances` 615‑693 (79) · ramas `settlements`/`settlement_items` de `envelope` y `readOnlyEnvelope` (~30) | 109 |
| `apps/mobile/src/screens/PayWorker.tsx` | entero | 406 |
| `apps/mobile/src/screens/PaymentsPanel.tsx` | entero | 435 |
| `apps/mobile/src/screens/Account.tsx` | se reescribe a lectura (393 → ~200) | 193 |
| `apps/mobile/src/screens/Adjust.tsx` | queda sólo el anticipo (172 → ~110) | 62 |
| `apps/mobile/src/receiptHtml.ts` | `payrollHtml` 181‑312 | 132 |
| `apps/mobile/src/data/repository.ts` | 14 de los 21 métodos de `PaymentsRepo`, y los tipos `SettlementPreview`, `PendingItem`, `PayrollRun`, `SettleResult`, `PendingWorker` | ~90 |
| **Total código** | | **≈ 1.963** |

Hay que escribir a cambio: una pantalla de anticipo (~120), la tarjeta de saldo
leído con su fecha (~60) y la lectura de `server_balances` en la ficha del
trabajador (~40). **≈ 220.** Neto: **−1.743 líneas de código**.

El móvil tiene hoy 23.418 líneas de TS/TSX, de las que 5.705 son pruebas. Se
borra el **11 %** de su código de aplicación.

### 1.2 Lo que se borra — pruebas

| Fichero | Qué | Líneas |
|---|---|---|
| `apps/mobile/src/data/repository.test.ts` | 27 de 52 pruebas (liquidar, anular, nómina, deshacer, planilla, `paidAgainst`) | 581 |
| `apps/mobile/src/ledger.test.ts` | 11 de 13; el fichero se queda sin objeto | 275 |
| `apps/mobile/src/sync/sync.test.ts` | las de liquidación bajada y las del checksum de saldo | ~200 |
| `apps/mobile/src/receiptHtml.test.ts`, `csv.test.ts` | las de liquidación y planilla | 36 |
| `packages/shared/golden/runner.ts` (522) + `golden.test.ts` (86) + `real-repository.test.ts` (264) | el recorredor de TypeScript entero. Los diez `cases/*.json` **se quedan**: pasan a ser la suite de regresión del servidor, que ya los ejecuta en `services/api/internal/apitest/golden_test.go` | 872 |
| **Total pruebas** | | **≈ 1.964** |

**Total borrado ≈ 3.927 líneas. Escrito ≈ 220. Neto ≈ −3.700.**

En el servidor no se borra **ni una línea**. La rama de rechazo de
`handlers_sync.go:402` se queda: pasa de ser la que salta a la que nunca salta,
que es exactamente donde tiene que estar una guarda.

### 1.3 Lo que se queda — y aquí discuto contigo

**El saldo mostrado: sí, y el código ya está construido para ello.**
`SERVER_BALANCES_SCHEMA` (`schema.ts:839`) y `recordServerBalances` existen. Lo
que cambia es su estatus: hoy el saldo del servidor es un **checksum** que se
compara contra el local y se tira (`engine.ts:634-693`); pasa a ser *el* número.
Tres condiciones que no son negociables, porque son literalmente la familia
entera de hallazgos de la consola web (A5, A6, A7):

1. nunca se enseña sin la marca de cuándo llegó, **en la misma línea**, no en una
   cabecera;
2. un teléfono que nunca oyó un saldo no enseña «$0» — enseña «no lo sé». La
   unión de cuatro estados sin miembro numérico para el desconocido, que el
   módulo de cosecha de la web ya resolvió bien;
3. con anticipos sin enviar, se enseña el saldo del servidor menos lo no
   enviado, etiquetado «provisional».

Ganancia lateral que vale por sí sola: hoy el saldo del teléfono **miente** para
quien además hizo jornales (§2.2), y `engine.ts:664-673` lo dice por escrito —
un trabajador con pesadas *y* jornales se reporta como bug de cálculo, y «dos
totales no bastan para distinguir *el teléfono sabe menos* de *las dos
implementaciones discrepan*». Con un solo saldo, esa ambigüedad no existe.

**El comprobante del anticipo: sí, y es más fácil de lo que parece.** Un recibo
de anticipo no necesita ningún cálculo: nombre, cédula, fecha, importe entregado,
firma. `receiptHtml` ya lo imprime; lo que se le quita es el desglose de pesadas
y el `paidCents` contra una liquidación (`ReceiptData.lines`, `balanceCents`,
`paidCents`). Queda un documento de ~90 líneas en vez de 180.

Un matiz sobre eso, y es importante: **el recibo del anticipo no puede llevar el
saldo.** Llevaría un saldo de hace seis días impreso en un papel que el
trabajador guarda. Lleva lo entregado, que es lo único que el teléfono sabe con
certeza.

**Donde discrepo contigo: si el teléfono muestra el saldo, tiene que mostrar
también los movimientos.** Un recolector que ve «$340.000» y no ve de dónde sale
no puede reclamar, y un saldo que no se puede impugnar es peor que ninguno. Eso
significa seguir bajando el `ledger` y aplicarlo —`applyLedgerEntry`,
`syncStore.ts:481-511`, 31 líneas— aunque ya no se bajen las liquidaciones. Es
la diferencia entre borrar 82 líneas y borrar 113, y las 31 valen la pena.

**Se queda entero, sin tocar:** la captura de pesadas, la corrección y el borrado
lógico, las cinco reglas de revisión, rendimiento/IRL, los informes de semana,
lote y trabajador, el CSV, el outbox y sus disparadores, el motor de sync para
`worker` / `workRecord` / `ledgerEntry`, los dos transportes, la exportación y la
importación de temporada, y las migraciones v5→v6→v7.

---

## 2. Qué se pierde

### 2.1 En el lote, sin señal

| Hoy | Después |
|---|---|
| Pesar, corregir, borrar | igual |
| Ver el saldo (derivado en local) | ver el último saldo conocido, con su fecha |
| Dar un anticipo, imprimir su recibo | igual |
| Dar una deducción | se muda a la web |
| **Liquidar la semana** | ya está prohibido por la decisión 5 (`PayWorker.tsx:112`) |
| **Pagar contra una liquidación** | se muda a la web |
| **Imprimir la liquidación definitiva** | se muda a la web |
| **Correr la nómina de la cuadrilla y firmar la planilla** | se muda a la web — **y en la web no existe todavía** |
| **Deshacer la nómina** | se muda a la web |

Hay que decir la mitad honesta: **buena parte de esa lista ya la había perdido la
decisión 5.** Sin señal, hoy, el botón de liquidar está apagado. Lo que la
propuesta quita de verdad y que hoy sí funciona *con* señal es liquidar y pagar
**desde el teléfono**, y la nómina de cuadrilla.

Y la nómina de cuadrilla es la pérdida que cuesta dinero de construcción: la web
paga **de uno en uno** (`apps/web/src/features/workers/PayWorkerPage.tsx`, 636
líneas, un trabajador por pantalla). Imprime la planilla
(`SettlementsPage.tsx:118`), pero no tiene la acción «liquidar y pagar a los
treinta». Eso hay que construirlo, y no es opcional: es lo que la finca hace los
sábados.

### 2.2 Una defensa local que desaparece

`pickups.isSettled` impide hoy corregir o borrar una pesada que ya está dentro de
una liquidación viva, **en el momento de escribir**. Sin liquidaciones locales,
esa comprobación la hace el servidor y llega tarde: el pesador corrige un peso el
jueves en el lote y el conflicto (`WORK_RECORD_SETTLED`) aparece cuando haya
señal, quizá el sábado.

Mitigación barata y que recomiendo incluir desde el primer día: seguir bajando
los `payable_id` reclamados como una **lista de lápidas** — un conjunto de UUID,
sin importes, sin precios, sin nombres. No es dinero, y devuelve el aviso al
momento de escribir.

### 2.3 El día que el servidor esté caído y haya que pagar

El escenario realista, no el catastrófico: **sábado por la tarde, treinta
recolectores esperando, la finca tiene señal pero el servidor no responde** — el
VPS caído, el certificado vencido, la base en mantenimiento, o el token de
refresco quemado por el hallazgo API 1 que ya se cerró pero que enseñó que esto
pasa.

- **Hoy:** se corre la nómina desde el teléfono, se paga, se firma la planilla.
- **Con la propuesta:** no se emite ninguna liquidación. La salida existe y es la
  decisión 5: se entrega el efectivo como **anticipo**, con su recibo, y la
  liquidación se emite el lunes amortizándolo al centavo — el caso de oro 02 lo
  fija.

O sea: **el dinero sí sale igual**. Lo que cambia es el papel que el recolector se
lleva a casa. Dice «anticipo, $180.000», no «liquidación, semana del 24 al 30,
190,5 kg a $950, $180.000». Para un jornalero que no sabe cuánto pesó, es peor. Y
quien se marcha de la finca ese sábado se marcha sin la cuenta cerrada.

**El peor escenario realista, nombrado sin adornos: la finca sin conectividad
estable.** Hoy Báscula es un producto que funciona sola en un teléfono, un
trimestre entero, sin servidor. Con la propuesta, un teléfono sin servidor es una
libreta de kilos. Si la finca de hoy es la única cliente y tiene señal en la casa
por la noche, esto cuesta cero. Si Báscula va a venderse a fincas de las que no
se sabe si tienen señal, la propuesta le corta ese mercado — y eso es una
decisión de negocio, no de arquitectura. Si la respuesta es «sí quiero vender a
esas fincas», entonces ni esta propuesta ni el modelo actual son la respuesta:
lo es la variante «provisional» de `sincronizacion.md` §6.4, y hay que costearla
ahora y no descubrirlo con la primera finca que la pida.

---

## 3. Los 26 hallazgos de la auditoría

### Se evaporan por construcción — 4

| # | Hallazgo | Por qué desaparece |
|---|---|---|
| API 4 | El redondeo en coma flotante hace discrepar teléfono y servidor en el **31 %** de las liquidaciones | Con un solo calculador no hay dos números que comparar. Está cerrado hoy; deja de **poder** reabrirse. La aritmética exacta sigue haciendo falta en el servidor, pero la clase «dos implementaciones del mismo dinero» se acaba |
| API 7 | El pull del pesador lleva el precio del kilo y todos los precios semanales | Un teléfono que no calcula importes **no tiene motivo para recibir un precio**. Hoy está cerrado con un filtro por rol; con la propuesta el precio deja de estar en la carga útil del pesador por diseño, no por un `if` que alguien puede tocar |
| API 9 (**abierta**, «necesita diseño, no parche») | Lo saltado por rol no vuelve nunca: un teléfono que cambia de manos se queda con el libro incompleto | El teléfono **no tiene libro**. El libro está en el servidor y se lee entero cada vez. **La propuesta es el diseño que el auditor decía que faltaba** |
| — (`engine.ts:664-673`) | Un trabajador con pesadas *y* jornales se reporta como bug de cálculo, y el propio comentario dice que no es decidible desde ahí | Hay un solo saldo. No hay nada que comparar |

### Se atenúan pero siguen — 3

| # | Hallazgo | Qué cambia |
|---|---|---|
| API 5 | El pesador escribe trabajadores por sincronización y enumera cédulas | Nada: el alta de gente en el campo se conserva |
| API 13 | Cantidades con más decimales de los que caben, redondeadas en silencio | Nada: la cantidad es justo lo que el teléfono sí manda |
| API 14 (abierta) | Suspender una finca no corta las sesiones vivas (hasta 15 min) | Sigue, pero el radio se encoge: en esos 15 minutos un teléfono suspendido ya no puede liquidar ni pagar, sólo anotar kilos |

### Siguen intactas — 19

API 1, 2, 3 (y la deuda que abrió su arreglo: no hay ruta que libere las
liquidaciones anuladas con línea viva que ya existan), 6, 8, 10, 11, 12; y las
doce de la consola, A1 a A12.

Con un matiz que hay que decir en voz alta: **las doce de la consola pesan más
después de la simplificación**, porque la consola pasa a ser el único sitio donde
se mueve el dinero. A1 —un doble clic paga dos veces, $20.000 entregados donde se
aprobaron $10.000— está cerrada. El día que vuelva un fallo de esa familia, ya no
hay un teléfono que sirva de segunda opinión.

### Nacen de la simplificación — 4

**N1. Un número que se enseña sin poder verificarlo.** Es exactamente A5/A6/A7
mudadas al teléfono. Se cubre con las tres condiciones de §1.3, y hay que
escribirlas antes de la primera línea, no auditarlas después.

**N2. El anticipo se entrega contra un saldo viejo.** Un capataz que ve
«$340.000 · hace 6 días» y entrega $300.000 puede estar entregando sobre un saldo
ya cobrado. No es un fallo del sistema —el caso de oro 07 fija que el exceso se
comporta como anticipo y el saldo se va a negativo— pero es dinero que sale de un
bolsillo por una cifra obsoleta. La antigüedad tiene que ir pegada al importe.

**N3. El aviso de «esta pesada ya se pagó» llega tarde.** §2.2. Nace de quitar
`isSettled`, y la lista de lápidas lo devuelve.

**N4. El teléfono deja de ser una segunda copia del dinero de la finca.** Hoy, si
el servidor pierde datos, el `.db` del teléfono los tiene todos. Después de la
fase P7 no: el teléfono tiene kilos y anticipos, y el resto vive sólo en
Postgres. La copia de seguridad del servidor deja de ser una buena práctica y
pasa a ser lo único. **Hay que nombrar quién la hace y cada cuánto antes del
corte, no después.**

**Marcador: 4 se evaporan, 3 se atenúan, 19 siguen, 4 nacen.**

---

## 4. La migración, con la finca real en plena cosecha

La propuesta **no cambia la migración: la simplifica.** La importación ya está
construida (`services/api/internal/store/import.go`, 754 líneas), conserva los
UUID del teléfono, es idempotente (`ON CONFLICT (id) DO NOTHING`) y **aborta la
transacción entera si un solo centavo de un solo saldo no cuadra**
(`reconcileImport`, import.go:554-633). Eso no se toca. Lo que cambia es qué app
queda encima al final.

| Paso | Qué | Riesgo |
|---|---|---|
| **P0** | Apagar la liquidación en el teléfono, sin desplegar código: cablear `capabilities.settleOffline` (hoy se decodifica y se tira) y poner la guarda de §6.1 también en `PaymentsPanel`, que hoy no la tiene | **Bajo, y es trabajo, no riesgo.** Son dos condicionales. Pero hasta que estén, cualquier plan tiene una nómina de cuadrilla sin candado |
| **P1** | La copia, y **restaurada** en un teléfono de repuesto, con tres cifras comparadas contra el original: kilos de la temporada, liquidaciones vivas, saldo del trabajador con más movimientos | **Ninguno.** Es una lectura. Y sin él, todo lo demás pierde su red: una copia que nadie ha restaurado no es una copia |
| **P2** | El ensayo de la importación contra una base de prueba, tantas veces como haga falta hasta que salga limpia | **Ninguno.** La base es desechable y el teléfono no se entera: `SyncRepo.seasonExport` es una lectura pura, y la interfaz lo declara devolviendo un valor y sin recibir callback |
| **P3** | **El corte.** Martes por la mañana, no día de pago, con alguien presente. Modo lectura de dinero → segunda copia → importación contra producción con las tres reconciliaciones **dentro** de la transacción → si algo falla, `ROLLBACK` | **ES EL ÚNICO PASO CON RIESGO.** Ver abajo |
| **P4** | Sólo pull, 24 horas. El teléfono recibe y no manda. Se comparan a mano cinco saldos, los kilos de la semana y el número de liquidaciones vivas | **Ninguno.** Nada se ha escrito en el servidor desde el teléfono; un error aquí sale gratis |
| **P5** | Push. El outbox se vacía en orden. Se reconcilia otra vez | **Ninguno** *si y sólo si* P0 está hecho. Si no, cada liquidación local pendiente en el outbox se rechaza y levanta una tarjeta de conflicto |
| **P6** | Desplegar la versión sin cálculo. **Aquí, y sólo aquí, se borran las 1.963 líneas** | **Ninguno.** Para entonces el servidor tiene la temporada, reconciliada al centavo, dos veces |
| **P7** | Se levanta el modo lectura, se retira el aviso de la web, se paga desde la web. Termina la mitigación de la decisión 3 | **Ninguno técnico.** Ver la advertencia del §6 |
| **P8** | La copia previa se guarda toda la temporada. Y ahora con más motivo: N4 | — |

**Por qué P3 es el único con riesgo, y cuál es el riesgo de verdad.** No es
perder datos: hasta P6 nada modifica el SQLite del teléfono de forma destructiva,
y si la transacción del servidor aborta, la finca sigue exactamente como estaba
porque **el teléfono no se ha tocado**. El riesgo es de **operación**: subir
11,7 MB por el enlace de una finca con un tiempo de espera de 25 segundos (deuda 4
del sprint 5). Un fallo ahí no pierde nada —es una respuesta que nadie leyó, y el
reintento es seguro por el `ON CONFLICT`— pero deja a la finca en modo lectura de
dinero más rato del previsto, un martes, con gente esperando. **Subir ese tiempo
de espera es el único cambio de servidor que la mudanza exige, y hay que hacerlo
antes del martes.**

**Por qué en los demás no hay riesgo, dicho de una vez:** P1 y P2 son lecturas.
P4 no escribe en el servidor. P5 sólo empuja hechos —pesadas y movimientos— que
son idempotentes por UUID en tres capas independientes (§4). P6 borra código
sobre datos que ya están reconciliados. La seguridad la da **el orden**, no la
prudencia de quien lo ejecuta.

**Un orden que NO hay que seguir, porque es el tentador:** desplegar primero la
app simplificada y migrar después. Deja a la finca sin poder liquidar en el
teléfono y sin que el servidor tenga la temporada — es decir, sin poder pagar por
ningún lado.

---

## 5. El plan alternativo, si el dueño dice que no

Qué queda a medias hoy para que el modelo actual sea defendible, en orden de
gravedad.

**A. Mover `settle` al servidor. Dos semanas, una pareja.**
Es el agujero del §0. Hay que: llamar a `POST /v1/settlements` con
`expectedGrossCents` (el servidor ya lo **exige**, `handlers_money.go:233`);
quitar `settlements` y `settlement_items` de `SYNCED_TABLES` para que dejen de
encolarse; construir la pantalla de `GROSS_CHANGED` con las dos cifras y la
semana que cambió (§5.5); y reescribir `runPayroll` como N llamadas al servidor
con su manejo de fallos parciales. Dos semanas es la estimación **optimista**:
`runPayroll` es la parte con más casos de borde vivos —`repository.test.ts` tiene
ocho pruebas dedicadas sólo a deshacer una nómina, incluida una de un devengo que
ya venía reversado.

**B. Que el saldo del teléfono deje de mentir. Tres semanas, una pareja.**
`engine.ts:664-673` dice que no se puede arreglar desde ahí. Arreglarlo de verdad
exige bajar jornales y contratos al teléfono, o sea la pantalla de labores del
móvil — el punto 4 de §10, que nadie ha costeado. Es una pantalla nueva, no un
ajuste. Mientras no exista, la ficha del trabajador enseña medio saldo a quien
hace las dos cosas, y la tarjeta roja de discrepancia salta por diseño.

**C. Las dos guardas del P0. Un día.**
Cablear `capabilities.settleOffline` y poner la guarda de §6.1 en
`PaymentsPanel`. Hacen falta elija lo que elija el dueño.

**D. Programar la poda de `sync_log`/`sync_ops`. Media hora.**
`main.go --prune` existe; falta el cron.

**E. Subir el tiempo de espera de la importación. Una línea.**

**Total del plan alternativo: unas cinco semanas de pareja**, contra ~1.500
líneas escritas — frente a ~3.900 borradas y ~220 escritas por el otro camino.

### Riesgos permanentes que acepta quien siga con el modelo actual

Aunque se cierre todo lo anterior:

1. **Dos implementaciones del mismo dinero, para siempre.** Los diez casos de oro
   existen porque hay dos motores. Cada regla nueva —una deducción con tope, un
   anticipo que caduca, un redondeo por lote— hay que escribirla dos veces, en
   TypeScript y en Go, y demostrar que coinciden. El hallazgo API 4 —31 % de las
   liquidaciones discrepando— es lo que pasa cuando una de las dos se escribe de
   memoria, y volverá a pasar, porque la disciplina que lo evita no es
   estructural: es que alguien se acuerde.
2. **Dos candados sobre el mismo hecho.** `ux_items_pickup_live` en SQLite y
   `ux_items_payable_live` en Postgres. §1.4 dice que eso no es un problema
   «una vez que sólo uno de los dos puede crear una liquidación» — o sea, es
   correcto exactamente en la medida en que se implemente **A**, y ni un día
   antes.
3. **La pantalla de conflictos hay que mantenerla y hay que enseñar a usarla.**
   Es la parte del sistema que sólo se ejerce cuando algo va mal, o sea la que
   nunca está probada en campo. Con el modelo actual son seis clases de tarjeta y
   tres son de dinero; con la propuesta se reducen a dos —pesada rechazada y
   trabajador de baja— y ninguna de dinero llega al pesador porque no hay ninguna.

---

## 6. Sobre el coste hundido, sin rodeos

Casi todo lo que se borraría se escribió esta semana: el repositorio entero tiene
dos días de historia. Eso **no** es un argumento para conservar nada, y conviene
decir por qué de forma que no suene a consigna: el coste ya está pagado, y
haberlo pagado no compra nada hacia adelante. La pregunta útil es qué cuesta
mantener cada línea **a partir de hoy**, y una línea que calcula dinero cuesta un
caso de oro, un puerto en Go y una discrepancia posible cada vez que alguien la
toca.

**Hay un sitio donde la antigüedad sí es un argumento, y va justo en la dirección
contraria a la que se espera.** Lo que se borra no es el código nuevo: es el
viejo.

- Escrito ayer y **nunca usado por la finca**: el motor de sincronización,
  `syncStore`, los dos transportes, la exportación e importación de temporada,
  las tres pantallas de sync, las migraciones v6 y v7. **Se quedan casi enteros.**
- Corriendo en la finca desde hace una temporada, pagando gente de verdad:
  `payments.settle`, `runPayroll`, `PayWorker`, `PaymentsPanel`, `Account`,
  `BALANCE_SQL`, `PENDING_SQL`, el recibo. **Es lo que la propuesta borra.**

Ese es el coste real y no aparece en ninguna cuenta de líneas: la nómina lleva
meses haciéndose con dos botones que el pesador y el administrador conocen de
memoria, y la propuesta los cambia por una pantalla web que en su forma de
cuadrilla todavía no existe. Cambiar código con kilometraje por código sin
kilometraje es la parte cara, y no se mide en líneas — se mide en un sábado de
pago que no salga bien.

Y una advertencia contra mi propia recomendación: **esta simplificación es más
fácil de defender en un documento que un sábado a las cinco de la tarde con
treinta personas esperando.** Si el dueño la acepta, P7 no se levanta hasta que la
web pague a una cuadrilla entera en una pantalla, con su planilla firmada, y
alguien lo haya hecho una vez con el papel delante.

---

## 7. Recomendación

**Recomiendo aceptar la propuesta, y el motivo es de coherencia, no de líneas de
código: la decisión 5 ya le quitó al teléfono la autoridad sobre el dinero, y lo
que queda en `payments.settle` es un motor de nómina que el servidor rechaza por
diseño (`handlers_sync.go:402`) mientras el pago que lo acompaña sí entra — un
doble pago esperando a que se retire la mitigación de la decisión 3.** Mantener
el modelo actual no es «no cambiar»: es comprometerse a dos semanas para mover
`settle` al servidor, tres más para bajar los jornales al teléfono y que el saldo
deje de mentir, y a sostener dos implementaciones del mismo dinero para siempre.
La propuesta llega al mismo sitio borrando ~3.900 líneas en vez de escribiendo
~1.500, y hace desaparecer por construcción cuatro hallazgos, incluida la 9 —la
única abierta de la que el auditor dijo que «necesita diseño, no parche»—.
Lo que cuesta es real y hay que firmarlo con los ojos abiertos: la nómina de
cuadrilla se muda a la web y **hay que construirla allí**, porque hoy la web paga
de uno en uno; el recolector que cobra un sábado con el servidor caído se lleva
un recibo de anticipo en vez de una liquidación; y Báscula deja de funcionar como
producto autónomo en un teléfono. Si esa última propiedad es parte del negocio
—vender a fincas sin señal fiable— entonces la respuesta no es ni esta propuesta
ni el modelo actual, sino la variante «provisional» de §6.4, y eso hay que
decidirlo ahora.
