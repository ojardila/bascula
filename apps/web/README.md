# `bascula-web` — consola de administración de la finca

Vite + React + TypeScript + React Router + MUI. Español en la interfaz,
comentarios del código en inglés, **dinero siempre en centavos enteros**.

## Arrancar

```sh
npm install --prefix apps/web --no-workspaces   # instala aquí, no en la raíz
npm --prefix apps/web run dev                   # http://localhost:5173
```

Arranca con **datos simulados**: no hace falta la API. Entre con
`oscar@laesperanza.co` / `esperanza` (dueño); la pantalla de login lista
también el administrador, el pesador y el super-admin.

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo con MSW |
| `npm run build` | `tsc` + bundle de producción en `dist/` |
| `npm test` | Vitest |
| `npm run lint` | ESLint |

## Mock o API real

Una variable decide:

```sh
VITE_USE_MOCKS=true                     # MSW intercepta /v1/* en el navegador
VITE_API_BASE_URL=http://localhost:8080 # a dónde van las peticiones si no
```

`.env.development` trae los mocks encendidos; el build de producción los apaga
y **los elimina del bundle** (la rama muere en tiempo de compilación).

Para una demo empaquetada con datos simulados:
`VITE_USE_MOCKS=true npm run build`.

## Cómo está organizado

```
src/
  api/          cliente HTTP, tipos del contrato, traducción de errores por code
  auth/         sesión y la matriz de roles (una tabla, no ifs)
  components/   AppShell, ModuleList (el molde de módulo), Money, guards
  features/     una carpeta por módulo
  lib/          dinero, fechas, uuidv7
  mocks/        MSW: la finca «La Esperanza» sembrada
```

Tres cosas que conviene saber antes de tocar nada:

1. **`components/ModuleList.tsx` es el molde.** Toda pantalla de lista lo usa:
   tabla, buscador, filtro por estado, alta, edición y baja lógica con
   confirmación. Con diez módulos por delante, un módulo nuevo que no lo use
   es un módulo que diverge.
2. **`lib/money.ts` es la única aritmética de dinero.** Es un port deliberado
   de `apps/mobile/src/format.ts`; se irá a `packages/shared` cuando ese
   paquete exista, y ese es el único sitio donde hay que tocar.
3. **`api/types.ts` es provisional a propósito.** El contrato dice que estos
   tipos se generan de `openapi.yaml` con `openapi-typescript`. Ese paquete se
   está escribiendo en paralelo; el archivo tiene la forma de la salida
   generada justamente para que sustituirlo sea cambiar un import.

## Lo que aún no está

Ventas, gastos, inventario, liquidaciones como pantalla propia, anotaciones,
usuarios, el polígono en el mapa (maquetado y deshabilitado) y RSP-009. La
barra lateral los muestra desactivados con el sprint en que llegan.
