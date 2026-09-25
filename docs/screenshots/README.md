# Screenshots

`web/` holds the current screens of the web app in a desktop browser, with demo data:

| File | Screen |
|---|---|
| `web-desktop-home.png` | Harvest dashboard (`/cosecha`) in a desktop browser |
| `web-desktop-week.png` | One week: kilos per day and per picker (`/cosecha/semana/:lunes`) |
| `web-desktop-account.png` | A picker's profile and balance (`/empleados/:id`) |
| `web-desktop-payroll.png` | Crew payroll (`/nomina`) |
| `web-desktop-crops.png` | Harvest per crop and lot (`/cosecha/cultivos`) |

The landing (`apps/web/public/landing/app/`) uses JPEG captures made the same way
at 1280×800, in a tighter browser-window frame: dashboard, recording a weighing,
the week, kilos per picker, payroll, paying a picker, a picker's account and lots.

## How they were made

1. `npm run dev` in `apps/web` with the mock API (`VITE_USE_MOCKS=true`).
2. In one browser page (the mock keeps its data in memory, so no reloads):
   sign up a new farm, open **Configuración → Cargar datos de demostración**,
   and add a few advances. Navigate with client-side routing.
3. Capture at 1440×900 (1280×800 for the landing) at 2× with Playwright,
   hiding the «Datos de prueba» banner.
4. Frame them in a browser window with the farm's address
   (`laesperanza.bascula.engp.io`).
