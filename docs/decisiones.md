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
