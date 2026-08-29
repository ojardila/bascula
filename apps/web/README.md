# `bascula-web` — consola de administración de la finca

Vite + React + TypeScript + React Router + MUI. Español en la interfaz,
comentarios del código en inglés, **dinero siempre en centavos enteros**.

Desde el sprint 2 esta app habla con la API de verdad (`services/api`). Los
datos simulados siguen ahí, pero como herramienta, no como la única realidad.

## Arrancar

```sh
npm install --prefix apps/web --no-workspaces   # instala aquí, no en la raíz
npm --prefix apps/web run dev                   # http://localhost:5173
```

Por defecto arranca con **datos simulados** y lo dice en pantalla: una franja
azul arriba avisa de que nada de lo que registre llega al servidor. Entre con
`oscar@laesperanza.co` / `esperanza` (dueño); la pantalla de login lista también
el administrador, el pesador y el super-admin.

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo |
| `npm run build` | comprueba los tipos generados, `tsc -b` y bundle en `dist/` |
| `npm run types:api` | regenera `src/api/schema.ts` desde `services/api/openapi.yaml` |
| `npm run types:check` | falla si esos tipos están desactualizados (lo corre `build`) |
| `npm test` | Vitest contra MSW: hermético, sin red |
| `npm run test:e2e` | Vitest contra la API viva (ver abajo) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |

## Simulado o de verdad

Una variable decide, y **no hay respaldo automático**: un modo que puede
cambiar solo es un modo que nadie puede razonar a las cuatro de la tarde.

```sh
VITE_USE_MOCKS=true      # MSW responde dentro del navegador
VITE_USE_MOCKS=false     # las peticiones salen a VITE_API_URL
VITE_API_URL=http://localhost:8099
VITE_API_BASE_URL=       # déjelo vacío: las rutas son relativas y pasan por el proxy
```

La elección se ve en tres sitios: la variable, una línea en la consola al
arrancar, y la franja en pantalla cuando está simulado.

### Contra la API real

```sh
cd services/api
make up
make migrate
PORT=8099 SIGNUPS_PER_IP_PER_HOUR=100 \
  DATABASE_URL="postgres://bascula_api:bascula_api_dev@localhost:5433/bascula?sslmode=disable" \
  go run ./cmd/api
```

y en `apps/web/.env.development` ponga `VITE_USE_MOCKS=false`.

En desarrollo el servidor **no envía correos**: devuelve el token de
verificación dentro de la respuesta del registro, así que la pantalla de
«Revise su correo» ofrece un enlace para confirmar y entrar sin buzón.

**El proxy de Vite no es una comodidad.** La API no monta ningún middleware de
CORS, así que una página servida en `:5173` no puede llamar a `:8099`
directamente: el preflight vuelve sin cabeceras y el navegador descarta la
respuesta antes de que nuestro código la vea, lo cual parece un fallo de red y
manda a buscar en la mitad equivocada del sistema. `vite.config.ts` reenvía
`/v1` y `/health` a `VITE_API_URL`, con lo cual pasa a ser el mismo origen y no
hay preflight que falle. En producción la misma propiedad tiene que darse por
despliegue: sirva el bundle detrás del mismo origen que la API, o ponga un
proxy inverso delante de los dos.

## La prueba de extremo a extremo

`npm run test:e2e` corre el cliente real de la app (`src/api/endpoints.ts`, el
mismo código que ejecuta el navegador) contra un servidor real con una base de
datos real, y recorre el camino que importa: registrar finca, confirmar, entrar,
contratar, abrir lote, poner precio, registrar dos labores, **liquidar**, pagar
una parte y comprobar el saldo.

Es la única prueba del repositorio que puede detectar que las dos mitades no
encajan. `npm test` corre contra MSW, así que solo confirma que la web está de
acuerdo con la idea que la web tiene de la API; la suite de Go corre contra
Postgres, así que solo confirma que la API está de acuerdo consigo misma. Las
dos estuvieron en verde todo el sprint 1 mientras `POST /v1/signup` desde esta
app era un 400.

Si el servidor no está levantado, **se salta con un cartel que dice qué comando
correr**, y no pasa. Una prueba de integración que reporta éxito sin haberse
conectado nunca es peor que no tenerla.

## Cómo está organizado

```
src/
  api/
    wire.ts       lo que el servidor manda de verdad (transcrito de los structs Go)
    adapters.ts   la traducción wire -> vista, en un solo sitio y con los porqués
    types.ts      los modelos de vista: lo que una pantalla puede saber
    endpoints.ts  una función por llamada; las pantallas nunca usan `http`
    refs.ts       las tablas de nombres para los joins del cliente
    client.ts     fetch, refresh transparente, errores como `ApiError`
    errors.ts     traducción de `code` -> frase en español
    mode.ts       simulado o real, explícito y visible
    schema.ts     GENERADO de openapi.yaml; no se edita
    contract.assert.ts  comprueba wire.ts contra schema.ts al compilar
  auth/           sesión y la matriz de roles (una tabla, no ifs)
  components/     AppShell, ModuleList (el molde de módulo), Money, guards
  features/       una carpeta por módulo (plots, workers, activities,
                  workrecords, inventory, sales, expenses, config, admin)
  lib/            dinero, fechas, uuidv7, geometría del mapa (geo.ts), stock.ts
  mocks/          MSW, emulando la API real ruta por ruta
e2e/              la prueba contra el servidor vivo
```

Cinco cosas que conviene saber antes de tocar nada:

1. **Hay dos vocabularios y una traducción.** El servidor dice `docId`,
   `unidad_trabajo`, `admin`; la interfaz dice `documentNumber`, `work_unit`,
   `administrator`. `adapters.ts` es el único sitio donde se cruzan. Eso fue lo
   que permitió que la API creciera ocho rutas y cambiara tres formas a mitad
   del sprint sin tocar una sola pantalla.
2. **El servidor manda ids, no nombres.** Una labor trae `workerId`,
   `activityId`, `unitId` y `plotIds`, y ni una cadena legible. El join lo hace
   el cliente (`refs.ts`), contra los datos que igual tenía que cargar para sus
   propios selectores. Un id que no resuelve se muestra como «—», nunca en
   blanco: una celda vacía en la columna Lotes se lee como «sin lote», que es
   un hecho distinto y cómodo.
3. **Pagar son dos escrituras.** Liquidar (`POST /v1/settlements`) es lo que
   convierte el trabajo en plata debida; solo entonces hay saldo contra el cual
   pagar. Saltarse el primer paso da un 409 `AMOUNT_EXCEEDS_BALANCE` que no se
   entiende hasta que uno sabe esto.
4. **`components/ModuleList.tsx` es el molde.** Toda pantalla de lista lo usa.
   Con diez módulos por delante, un módulo nuevo que no lo use es un módulo que
   diverge.
5. **`lib/money.ts` es la única aritmética de dinero.** Port deliberado de
   `apps/mobile/src/format.ts`; se irá a `packages/shared` cuando ese paquete
   exista, y ese es el único sitio donde habrá que tocar.

### El contrato, y quién manda sobre los tipos

`services/api/openapi.yaml` ya existe, así que la deuda declarada en el sprint 2
—«`wire.ts` está transcrito a mano»— se cerró, pero **no** reemplazando
`wire.ts` por lo generado. Los tres archivos conviven y cada uno tiene un
trabajo:

```
src/api/schema.ts           generado, nunca se edita a mano (npm run types:api)
src/api/wire.ts             escrito a mano, comentado, lo que importa la app
src/api/contract.assert.ts  sin runtime: comprueba que los dos dicen lo mismo
```

Lo generado son 6.500 líneas de `components["schemas"]["Sale"]["properties"]`.
Leer el flujo de datos de una pantalla a través de eso es peor que leerlo en
`wire.ts`, y cada comentario de «por qué esto llega en null» —los que costaron
una tarde cada uno— no tiene dónde vivir en un archivo generado. Así que lo
generado es el **juez**, no la fuente:

- `contract.assert.ts` compara, en tiempo de compilación, el conjunto de campos
  y los tipos de cada `Wire*` contra su esquema. Si el servidor renombra un
  campo, `tsc` falla **diciendo cuál**: `["sobra en wire.ts:", "warehouse"]`.
- `scripts/check-openapi-types.mjs` corre en cada `npm run build` y falla si
  `schema.ts` se quedó atrás del `openapi.yaml`. Regenerar es un acto
  deliberado con un diff revisable, y **ese diff es el aviso de que el contrato
  se movió**. Regenerar en silencio dentro del build es justamente cómo el
  sprint 1 pasó una semana con las dos mitades en desacuerdo y verde en las dos.

Ya encontró cosas: `WireActivityRate.timeUnit` estaba como `string` cuando el
contrato tiene una enumeración de cinco valores (y el servidor dice
`personalizado` donde la interfaz dice `custom`).

## Lo que la API todavía no tiene

Estas cosas están en la interfaz y el adaptador devuelve un vacío honesto en vez
de inventar un valor plausible, que es como una pantalla termina siendo de fiar
para una cifra que nadie calcula:

- **Foto del empleado.** `photoId` apunta a un almacén de medios que no existe;
  no hay URL que construir, así que el avatar cae a la inicial.
- **Fecha de ingreso.** No hay columna. `createdAt` es cuándo se creó la fila,
  que no es cuándo entró la persona.
- **Número de recibo.** La API no emite ninguno; la pantalla de pago imprime el
  id del movimiento, que al menos es algo que se puede citar.
- **Correo del dueño y conteo de empleados en la consola de plataforma.** El
  super-admin no puede leer usuarios ni empleados de una finca: la proyección
  *es* la restricción.
- **Periodo de prueba de la finca.** No existe en la API. Lo inventó el mock.

## El mapa

El polígono del lote se dibuja, se edita y se guarda contra
`PUT /v1/plots/{id}/boundary` (GeoJSON de ida y de vuelta). Vive en
`features/plots/PlotBoundaryEditor.tsx` y en `lib/geo.ts`.

**No hay teselas, y eso no es una versión degradada.** Esta consola se publica
bajo una política que rechaza peticiones a servidores que no sean su propio
origen —la misma regla que permite servirla junto a la API sin CORS—. Todo mapa
en teselas (OSM, Mapbox, Esri, Google) es un `fetch` por cuadro de 256 píxeles
contra el dominio de otro, así que Leaflet o MapLibre aquí no serían «un mapa
con teselas lentas»: serían un rectángulo gris con gestos, 140 kB de caché de
teselas, y un dueño que concluye, con razón, que la pantalla está rota. Se
comprobó antes de escribir nada: ninguna fuente de teselas es del mismo origen,
el repositorio no trae un paquete de teselas fuera de línea, y la API no sirve
`/tiles`.

Lo que hay en su lugar es un **lienzo de coordenadas**: un plano equirectangular
local en metros, centrado en el lote, con cuadrícula métrica, barra de escala,
la latitud y la longitud reales de cada esquina, y **los demás lotes de la finca
dibujados detrás en gris**. Eso último es lo que hace el trabajo que haría una
foto aérea: a partir del segundo lote, el linde que importa es el del vecino.
Además, opcionalmente: una **imagen de fondo que aporta el dueño** (un dron, un
plano catastral, una captura hecha en otra parte), anclada al encuadre sobre el
que se soltó, que se queda en ese navegador y no se sube a ningún sitio; y la
**ubicación del propio equipo** por `navigator.geolocation`, que es un permiso
del navegador y no un servidor externo.

Las dos superficies —la declarada y la del polígono— se muestran siempre juntas
y del mismo tamaño (`AreaComparison`), con la diferencia dicha en hectáreas y en
porcentaje, en tono neutro y sin regañar: la declarada viene de la escritura y
el polígono de trazar una ladera con el ratón, y quién de las dos sirve lo
decide el dueño. Un `INVALID_GEOMETRY` se dice en español y **sobre el dibujo**:
`lib/geo.ts` detecta el cruce antes de la red y pinta de rojo los dos lados que
se pisan.

El área que se ve mientras se dibuja usa la suma de exceso esférico sobre la
**esfera autálica** (latitud autálica incluida), que es lo que hace `ST_Area`
sobre `geography` por dentro: para el cuadrado de ejemplo de `openapi.yaml`,
PostGIS responde 122,506 ha y este código calcula 122,5055. La versión ingenua
del mismo cálculo da 123,04, y media hectárea de salto al pulsar Guardar es
exactamente lo que hace que nadie se fíe de ninguna de las dos cifras.

## Inventario, ventas y gastos

RSP-018 … RSP-033, sobre el mismo `ModuleList`. Dos reglas del diseño están
metidas en los tipos, no en un comentario dentro de un formulario:

- **Las existencias se derivan de los movimientos.** No hay ningún campo en
  ninguna pantalla que acepte escribir una cantidad en stock, y no hay
  `updateStock` en `endpoints.ts`. La única forma de que un número se mueva es
  `createStockMove`, que añade un hecho. El diálogo enseña el resultado antes de
  guardar —«hoy hay 28, después quedan 38»— para que el número que uno iba a
  teclear siga estando a la vista, pero se llegue a él diciendo qué pasó. El
  signo lo pone el motivo (`stock_sign`), no la persona.
- **Un gasto se imputa a una actividad o a un lote/cultivo, nunca a las dos ni a
  ninguna.** `ExpenseInput` es una unión discriminada, así que «a las dos» y «a
  ninguna» no son formas que el formulario pueda construir; y en pantalla, los
  campos del tipo que no se eligió no están deshabilitados, **no existen**.

## Lo que aún no está

Liquidaciones como pantalla propia, usuarios, RSP-009 y el adjunto del
comprobante de venta (`/v1/uploads` existe en el servidor; la pantalla todavía
no sube archivos, y prefiere no poner una casilla que se traga la foto). La
barra lateral muestra los módulos que faltan desactivados con el sprint en que
llegan.

**El aviso de sincronización sigue puesto y sigue siendo cierto**: hasta que
exista la sincronización, una labor registrada aquí no existe para el teléfono
y viceversa, y el candado anti-doble-pago vive en cada base por separado. Pague
desde un solo lado.
