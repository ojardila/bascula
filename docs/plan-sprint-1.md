# Sprint 1 — Báscula: el esqueleto multitenant y el ciclo del trabajo pagado

## 1. Objetivo y demo

**Objetivo:** dejar corriendo el módulo transversal (finca, usuarios, permisos, baja lógica) y **una sola cadena de valor completa: parcela → empleado → actividad → labor → saldo → pago**, construida con el patrón que después replican los otros seis módulos.

**Demo (20 min, un hilo):** se da de alta la finca "La Esperanza" y su dueño → login → se crea una parcela (departamento/municipio, área, dos cultivos) → tres empleados con foto y documento → dos actividades: *Recolección de café* (pago por unidad de trabajo, $800/kg) y *Guadañada* (pago por unidad de tiempo) → se registran labores de dos días sobre esa parcela → se abre el perfil de un empleado: saldo e historial financiero → se le paga → saldo en cero, el pago queda en el historial → se intenta entrar con un usuario sin permiso al módulo de empleados y la API lo rechaza → un segundo dueño de otra finca no ve nada de la primera. Cierre: `npm test`, los 75 tests del móvil verdes.

## 2. El recorte, y por qué

**Entra:** AUTENTICACIÓN + ALTA DE FINCA, CONFIGURACIÓN (solo datos de finca, precios y usuarios), PARCELAS **sin polígono**, EMPLEADOS, ACTIVIDADES, LABORES.
**Espera:** PRODUCTOS/INVENTARIOS y stickers, VENTAS, GASTOS, polígono en mapa, anotaciones, RSP-009 (cross-tenant).

El corte no es por facilidad:

- **Auth/permisos/baja lógica es prerrequisito de los 33 casos**: cada uno empieza verificando permiso y ninguno borra en duro. Se construye una vez como patrón y los demás módulos lo consumen.
- **LABORES es el corazón del negocio y el nudo de dependencias**: necesita empleado, actividad y lote/cultivo. Entregarla obliga a modelar bien los tres. Si en su lugar hiciéramos VENTAS o INVENTARIOS —que son CRUD más simples— tendríamos más casos cerrados y ningún riesgo resuelto.
- **GASTOS y VENTAS son dinero que no depende de nadie**: se pueden hacer en cualquier sprint, en paralelo, sin bloquear nada. Por eso esperan.
- **El polígono en mapa se saca de PARCELAS, no la parcela entera**: es la parte cara (librería, dibujo, geometría en Postgres) y no bloquea a LABORES, que solo necesita el id del lote. La parcela nace con nombre, ubicación, área y cultivos; el mapa se le añade encima en Sprint 2.
- **La foto y el comprobante empujan almacenamiento de archivos**: entra solo la foto del empleado (una ruta de subida), y esa misma ruta sirve luego para comprobantes de venta y stickers.

## 3. La tensión del modelo: se asume el modelo general, ya

**Decisión del equipo (no del dueño): el Sprint 1 modela recolección como una ACTIVIDAD de pago por unidad de trabajo (kg), no como entidad propia.** El móvil no se toca.

- *Asumir el general (elegido):* un esquema que sostiene los 33 casos desde el primer commit. Cuesta que la nómina del servidor y la del teléfono dejan de ser el mismo código durante unas semanas. Se mitiga con los casos de oro (H10): una labor de recolección tiene que producir **exactamente los mismos centavos** que `BALANCE_SQL` del móvil, caso por caso, o el sprint no cierra.
- *Diferirlo:* Sprint 1 sale una semana antes y luego hay que rehacer esquema, API y web, y migrar datos de producción — justo en el Sprint 3, encima del sync, que es la parte que puede perder plata. Es la peor combinación posible.

Consecuencia práctica: `pickups` no existe en Postgres. Existe `labores` con `modalidad_pago ∈ {contrato, tiempo, trabajo}` y `cantidad + unidad`; recolección es `trabajo/kg`.

## 4. Historias, en orden de dependencia

**H1 · Contrato y patrón de módulo** (M · Arquitecto + BE1) — *Como equipo quiero un contrato y un molde de módulo para que diez módulos no se escriban de diez formas.* AC: OpenAPI 3.1 en `packages/shared`; generador de tipos TS y structs Go, CI falla si hay diff; molde documentado con listar/crear/modificar/eliminar-lógico, chequeo de permiso a la entrada, validación de obligatorios y respuesta de error uniforme; dinero en centavos, ids UUID.

**H2 · Alta de finca, auth y permisos** (L · BE2) — AC: alta de finca con su primer usuario dueño; login/refresh con `farm_id` y rol; matriz dueño/administrador/pesador aplicada **en servidor** con test por rol y por módulo; `403` documentado; argon2id y rate limit.

**H3 · Esquema multitenant con RLS y baja lógica** (M · DBA + BE1) — AC: `farm_id` y `deleted_at` en toda tabla; RLS con `app.current_farm`, rol de aplicación sin `BYPASSRLS`; test de dos fincas sembradas que prueba el aislamiento; ninguna ruta hace `DELETE`.

**H4 · Parcelas, lotes y cultivos** (M · BE1) — AC: parcela con nombre, departamento, municipio, área y **varios cultivos**; lotes dentro de la parcela; campo `poligono` en el esquema, sin endpoint aún; baja lógica que no huérfana labores.

**H5 · Empleados** (M · BE2) — AC: identificación única por finca, foto subida a almacenamiento, perfil que devuelve saldo derivado del ledger e historial financiero paginado; baja lógica conserva el historial.

**H6 · Actividades** (S · BE1) — AC: categoría, unidad y las tres modalidades de pago con su tarifa; validación de que la tarifa corresponde a la modalidad.

**H7 · Labores** (L · BE1 + BE2) — AC: empleado ejecuta una actividad sobre lote y cultivo con fecha y cantidad; genera un `devengo` en el ledger calculado según la modalidad; una labor ya liquidada no se modifica ni se anula sin reverso; los casos de oro pasan.

**H8 · Pagar y registrar deuda** (M · BE2) — AC: pago, anticipo y deducción como filas de ledger; saldo a favor sale correcto; nada se edita, se reversa.

**H9 · Web: cascarón, alta de finca y login** (M · FE1) — AC: Vite+React+TS, cliente generado del OpenAPI (cero tipos a mano), MSW con los mismos mocks; navegación por módulos que oculta lo que el rol no puede.

**H10 · Web: lista/formulario reutilizable + parcelas y empleados** (L · FE2 + FE1) — AC: un componente de módulo (tabla, buscador, alta, edición, baja con confirmación) usado por los dos; el alta de parcela sigue el patrón de cropti/farmlogs: paso 1 identidad y ubicación por departamento/municipio, paso 2 cultivos, **con el espacio del mapa maquetado y deshabilitado** para que el Sprint 2 solo lo rellene; foto del empleado con recorte.

**H11 · Web: actividades, labores y perfil del empleado** (L · FE2) — AC: registro de labor en pocos toques (empleado → actividad → lote → cantidad); perfil con saldo, historial y botones de pagar/registrar deuda.

**H12 · Dominio del dinero compartido + casos de oro** (L · MOB1 + MOB2) — AC: `ledger/harvest/week/format` movidos a `packages/shared` con sus tests, sin cambio de comportamiento en el móvil; `golden/*.json` con recolección-como-labor, saldo a favor, anticipo y anulación, corriendo en el CI de TS **y** de Go.

## 5. Reparto

| Quién | Sprint 1 |
|---|---|
| **BE1** | H1 con arquitecto → H3 con DBA → H4 → H6 → H7 |
| **BE2** | H2 → H5 → H8 → H7 |
| **FE1** | H9 → H10 parcelas → H8 en web |
| **FE2** | H10 componente de módulo + empleados → H11 |
| **MOB1/MOB2** | H12; después, capa `Repository` en el móvil para poder cambiar SQLite por API en Sprint 3 sin tocar pantallas |
| **Arquitecto** | H1 días 1-2, luego árbitro del contrato y revisor de PRs |
| **DBA** | RLS, índices, almacenamiento de archivos, backup probado |

El móvil no escribe cliente HTTP ni sync: trabaja sobre lo único ya cierto (la lógica de dinero, con tests) y produce la especificación ejecutable que Go tiene que igualar.

## 6. Riesgos

- **El modelo general resulta mal calibrado con 33 casos escritos y no leídos por nosotros.** Mitigación: el documento RSP entra al repo el día 1 y el arquitecto mapea cada caso a una tabla antes de la primera migración.
- **TS y Go derivan.** OpenAPI única fuente, generación en CI, nadie escribe tipos a mano.
- **La web bloqueada por la API.** Día 3 todos los endpoints existen con contrato correcto y datos sembrados; el front va con MSW y cambia por variable de entorno.
- **Go calcula distinto que el móvil.** Los goldens son test bloqueante.
- **Diez módulos con diez estilos.** El molde de H1 y el componente de H10 son requisito de aceptación de cualquier PR de módulo.
- **Romper el móvil en producción.** Solo refactor cubierto por los 75 tests, sin release.
- **RSP-009 se cuela.** Fuera del sprint por decisión explícita; ver abajo.

## 7. Tres decisiones del dueño

1. **RSP-009 (historial del empleado en otras fincas).** Es dato personal de un tercero y rompe el aislamiento por diseño; no lo decide el equipo. ¿(a) lo retiramos del producto; (b) versión mínima: solo señales —"este documento existe en N fincas" o "tiene una alerta activa"—, nunca kilos, pagos ni nombres de finca, con registro de quién consultó y autorización firmada del empleado en el alta; o (c) historial completo compartido, lo que exige asesoría legal de habeas data antes de escribir una línea?
2. **Alta de fincas.** Tu doc trae REGISTRO DE FINCA (autoservicio) y tú pediste un super-admin que las cree. ¿(a) autoservicio abierto con verificación por correo; (b) solo el super-admin las crea y entrega credenciales; o (c) autoservicio pero la finca nace en prueba y el super-admin la activa?
3. **Tu finca durante la transición.** Hasta que exista sync (Sprint 3), ¿(a) la web registra labores desde ya, aceptando que el teléfono y el servidor lleven cuentas separadas unas semanas; o (b) la web solo administra —parcelas, empleados, actividades, precios, usuarios— y el registro de trabajo sigue siendo exclusivo del móvil?

## 8. Backlog siguiente

**Sprint 2 — Cerrar el dinero y el mapa.** GASTOS por actividad y por lote · VENTAS con foto de comprobante · polígono de parcela en mapa al estilo cropti/farmlogs, con área calculada · CONFIGURACIÓN completa (precios históricos, usuarios e invitaciones) · anotaciones de empleado · liquidación y comprobantes PDF desde la web · audit log consultable.

**Sprint 3 — Inventarios y sync.** PRODUCTOS e INVENTARIOS con stickers y movimientos · sync del móvil (UUIDs, push/pull idempotente, servidor dueño del bloqueo de liquidación, pantalla de conflictos) · el móvil leyendo su finca de la API · recolección del teléfono migrada a labor · reportes y rendimiento en la web · suspender finca · observabilidad y backups.
