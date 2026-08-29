# Decisiones del dueño

Lo que el equipo no podía decidir solo. Cada una cierra una discusión abierta en
los diseños; si alguna cambia, cambia el esquema o el contrato, así que se
anotan aquí con su fecha y su consecuencia.

## 2026-08-28

### 1. Historial del trabajador entre fincas — solo períodos y quién consultó

Se construye el servicio `registry`, pero **no publica opiniones**.

Se comparte: que la cédula existe, en cuántas fincas trabajó y en qué **meses**.
Nunca sale de la finca: anotaciones, saldos, deudas, anticipos, kilos,
rendimiento, teléfono, dirección, foto, ni el nombre de las fincas.

Toda consulta queda registrada con quién la hizo y para qué, y **el trabajador
puede leer ese registro**. Si esa pantalla no se construye, el registro no se
habilita.

`employee_notes` nace con `visibility = 'private'` y no tiene ruta de salida. La
tabla `employment_spans` no tiene columna de texto libre, ni bandera, ni puntaje:
no hay dónde escribir un juicio sobre una persona, y eso es deliberado. El
esquema es la defensa, no una política escrita que alguien pueda saltarse.

Las "alertas de seguridad" de RSP-009 quedan fuera. Un semáforo sobre una
persona, consultable por cédula en toda la región, es una lista negra laboral con
otro nombre, y la Ley 1581 de 2012 la haría responsabilidad de la plataforma.
Existe una versión defendible —hechos de un catálogo cerrado, atribuidos,
notificados al trabajador, disputables y caducos a 24 meses— y se puede construir
después, por decisión escrita, no encendiendo un `if` un martes.

### 2. Alta de finca — auto-registro abierto

`POST /v1/signup` es público, con verificación por correo y limitación de
frecuencia. La finca queda activa sin que nadie intervenga.

La consola de super-admin deja de ser la puerta de entrada y se queda con lo que
sí necesita: ver las fincas, suspender una, y nada más. Sigue sin poder leer
empleados, labores ni dinero de ninguna.

Consecuencia: el registro público es la superficie de ataque más expuesta del
sistema. Necesita limitación por IP, verificación de correo antes de la primera
sesión, y un límite de fincas por correo.

### 3. La web registra labores desde el sprint 1

No se espera a la sincronización. Se acepta que durante unas semanas el teléfono
y el servidor lleven cuentas separadas.

Consecuencia, y hay que decirla clara: **hasta que llegue la sincronización, una
labor registrada en la web no existe para el teléfono y viceversa.** Pagarle a
alguien desde los dos lados en la misma semana lo paga dos veces, porque el
candado anti doble pago vive en cada base por separado.

Mitigación mientras dure: durante la transición se paga **desde un solo lado**.
La web muestra un aviso permanente hasta que la sincronización esté en
producción.

### 4. Los precios de actividad tienen historial por fechas

Igual que el precio semanal de la recolección, que ya funciona así. Cada
actividad guarda sus precios con vigencia; una labor congela el que estaba
vigente en su fecha.

Consecuencia en el esquema: `activity_pay_*` deja de guardar un precio suelto y
gana una tabla de vigencias con `valid_from`, con un índice que impide dos
precios solapados para la misma actividad. Y una regla que ya estaba en el
diseño se vuelve obligatoria: una labor con precio derivado por fecha tiene que
ser **de un solo día**. Un jornal de martes a martes no tiene una única fecha de
vigencia, y derivar un precio sobre un rango es exactamente la ambigüedad que
termina en un pago mal calculado.

## Pendiente de decidir

- **El repositorio público de actividades y productos** (RSP-010, RSP-018): los
  casos de uso dicen que se traen "de internet", pero ese catálogo no existe
  todavía en ninguna parte. ¿Quién lo mantiene?
- **RSP-022, RSP-023 y RSP-024** faltan en el documento de casos de uso.
- **El auto-registro no tiene caso de uso escrito.** RSP-033 es *Eliminar Gasto*;
  la sección "Registro de finca" quedó sin numerar y sin detallar.

---

# Decisiones del equipo

Las que el equipo sí podía tomar, anotadas porque contradicen algo que ya
estaba escrito en los diseños.

## 2026-08-29 — Las categorías son catálogos, no enumeraciones

`arquitectura-api.md` fijaba tres categorías de actividad y `modelo-datos.md`
declaraba cuatro. Los dos se equivocaban: RSP-011 dice que el selector viene
«con opción de crear una nueva». Una finca que además cultive cacao inventará
categorías que nadie previó, y con un `ENUM` de Postgres cada una de ellas sería
un `ALTER TYPE` en producción.

Así que `activity_categories` es una tabla por finca, sembrada al crearla con
las tres de arranque, y `SEED_ACTIVITY_CATEGORIES` en `packages/shared` es solo
esa semilla. Lo mismo para todo lo que los casos de uso describen con «agregar
si no existe»: tipos de cultivo, variedades, unidades de trabajo, categorías de
producto y unidades de almacenamiento.

Siguen siendo enumeraciones cerradas las que el código ramifica y que no
significan nada si una finca inventa un valor: `ledger_kind`, `pay_method`,
`farm_role`, `settlement_status`, `pay_scheme`, `time_unit` y `stock_reason`.

## 2026-08-29 — Una labor se llama `work_record`, y solo así

Los documentos traían tres nombres para la misma entidad: `arquitectura-api.md`
usa `/v1/tasks` en su Entrega 2 y `work_records` en la revisión 2, y
`modelo-datos.md` la llama `labors`. Con eso, el frontend construyó contra un
nombre y el backend iba camino de otro.

Queda `work_records`: tabla, endpoints `/v1/work-records`, y `payable_id` en
`settlement_items` con el índice parcial anti doble pago intacto. `tasks` es
demasiado genérico y choca con cualquier tarea de sistema; `labors` en inglés
significa otra cosa. En la interfaz en español se sigue llamando «labor», que es
la palabra del dueño.

## 2026-08-29 — Un solo React en todo el monorepo

La app móvil fija React en la versión que trae su Expo SDK. La web pedía un
rango que resolvía a otra, y npm instalaba las dos. Dos instancias de React en
el mismo proceso devuelven contextos nulos y tumban cualquier hook que los lea:
las pruebas de la web fallaban por eso, no por su código.

El `package.json` raíz fija ahora `react` y `react-dom` con `overrides`. Cuando
Expo suba de versión, ese es el único sitio que hay que tocar.

## Pendiente antes de desplegar: CORS

La API no monta CORS, así que un navegador no puede llamarla desde otro origen.
En desarrollo lo resuelve el proxy de Vite, que reenvía `/v1` y `/health`, y eso
está bien mientras solo haya laptops. Antes de desplegar hay que elegir: servir
la web y la API detrás del mismo origen, o montar CORS en el servidor con una
lista de orígenes permitidos. La primera es más simple y no abre nada; la
segunda hace falta si la web va a vivir en otro dominio.

---

## 2026-08-29 — Sincronización: las cuatro que faltaban

### 5. El teléfono deja de liquidar sin señal

En el lote se entrega un **anticipo**, que se amortiza exacto cuando se liquide.
El cierre de semana se hace con señal, contra el servidor, que es el único dueño
del candado anti doble pago.

No es una renuncia disfrazada: un anticipo no reclama ninguna pesada, así que no
toma ningún candado y dos teléfonos sin señal se funden por unión sin
posibilidad de conflicto. El caso de oro 02 ya demuestra que un anticipo mayor
que la semana se amortiza contra las siguientes con el saldo exacto.

Lo que se evita es lo contrario: con dos candados, uno en cada base, pagar desde
el teléfono y desde la web en la misma semana paga dos veces, y re-derivar
después no devuelve el efectivo que ya salió del bolsillo.

### 6. Lotes y precio semanal, solo en la web

El teléfono los lee y no los cambia. Evita que dos personas pongan precios
distintos para la misma semana, que es el conflicto que no tiene una respuesta
correcta: cualquiera de los dos precios deja a alguien mal pagado.

Coste que hay que asumir y decir en voz alta: abrir un lote nuevo a mitad de
cosecha ya no se puede hacer desde el lote. Alguien tiene que llegar a un
computador.

### 7. El teléfono muestra el saldo completo, aunque no pueda detallarlo

Cuando la web registre jornales y contratos, el teléfono sumará todo lo que la
persona tiene pendiente, no solo lo suyo de recolección, aunque solo pueda
desglosar las pesadas. Un saldo que solo cuenta la mitad del trabajo es un saldo
que miente, y quien lo lee no tiene forma de saberlo.

### 8. Un trabajador de baja con trabajo nuevo se reactiva solo

Si volvió a trabajar, es que sigue en la finca. El equipo recomendaba lo
contrario —dejarlo de baja y avisar, porque la baja la decidió alguien— y el
dueño decidió la reactivación automática.

Consecuencia que hay que cubrir: la reactivación **queda registrada** con qué
labor la provocó y desde qué dispositivo, para que quien dio la baja pueda ver
que se deshizo y por qué. Deshacer en silencio una decisión de una persona es lo
único que no puede pasar aquí.

## 2026-08-29 — Los cinco huecos que la sincronización destapó

Al implementar el protocolo aparecieron cinco casos que no cubría. Ninguno lo
decidió la pareja que los encontró, que es lo correcto: deciden pagos.

### Los tres que cierra el equipo

**Una pesada que llega nombrando a alguien que el teléfono no tiene.** El
protocolo cubre un cultivo *borrado*, no uno *ausente*. Un referente ausente no
es un conflicto, es un pull incompleto: el teléfono pidió las pesadas antes que
las personas. Se ordena la recepción para que los referentes bajen primero
—fincas, personas, lotes, cultivos, actividades, precios y solo entonces
labores y movimientos— y una pesada huérfana pasa a ser un error del cliente que
se reintenta, no una fila que se guarda apuntando a nada.

**Un trabajador reactivado que la web vuelve a dar de baja entre dos
sincronizaciones.** Gana la baja. La reactivación es automática y la baja la
decide una persona mirando el caso; una decisión humana posterior no la puede
deshacer un automatismo. El trabajo registrado no se pierde —queda, y la persona
queda inactiva—, y el teléfono lo muestra como conflicto para que alguien lo
mire.

**`IDEMPOTENCY_KEY_REUSED` no está en la tabla de conflictos del protocolo.**
Es un código real del servidor y significa algo preciso: el mismo id con un
cuerpo distinto. No es un reintento y no se debe reintentar — es un error de
programación del cliente o una colisión de identificadores, y las dos cosas
tienen que verse. Entra en la tabla como caso que se muestra y no se resuelve
solo.

### Los dos que son trabajo de servidor, y esperan

**El teléfono todavía liquida en local.** El protocolo quiere que la liquidación
la cree el servidor, y la pareja hizo bien en no moverla: la temporada de
liquidaciones que ya existe en el teléfono no se ha importado, así que una
liquidación creada en el servidor reclamaría pesadas que el servidor no tiene.
El orden correcto es importar primero. Hasta entonces el botón exige estar
sincronizado, que es la mitad de la garantía.

**La carrera entre previsualizar y liquidar no está protegida.** El protocolo
pide que el cliente mande el bruto que vio (`expectedGrossCents`) y que el
servidor rechace la liquidación si ha cambiado. Ese campo no existe todavía. Sin
él, alguien puede liquidar mirando una cifra y firmar otra.

## Deuda declarada al cerrar el sprint 5

Cosas que se rodearon con honestidad y hay que cerrar. Ninguna está escondida:
en la pantalla se ve que falta.

1. **`GET /v1/settlements` no existe.** Solo hay `POST`. La consola compone la
   lista recorriendo el libro de cada empleado por el `settlementId` del
   devengo, lo cual funciona y no escala. Falta la ruta.
2. **`/v1/users` no existe.** La pantalla de invitar a alguien a la finca está
   construida y dice qué rutas espera; hoy la única forma de crear un usuario es
   registrando una finca nueva.
3. **La reactivación automática de un trabajador de baja con trabajo nuevo**
   —decisión 8 del dueño— no está implementada en el servidor. Hoy la pesada
   entra y la persona sigue de baja, que es lo contrario de lo que se decidió.
   Y falta el registro de auditoría que era la condición para que fuera segura.
4. **El tiempo de espera de la importación son 25 segundos**, y una temporada
   son 11,7 MB. En el enlace de una finca eso se puede quedar corto. Un fallo
   ahí no pierde datos —es una respuesta que nadie leyó, y el reintento es
   seguro— pero conviene subirlo antes de la mudanza real.
5. **La poda de `sync_log` y `sync_ops`** no está programada. El lado que la
   detecta (`CURSOR_TOO_OLD`) sí existe, así que el día que se pode, un teléfono
   muy atrasado se entera en vez de recibir historia incompleta.
