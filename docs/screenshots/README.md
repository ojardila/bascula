# Screenshots

`web/` holds the current screens of the web app, with demo data:

| File | Screen |
|---|---|
| `web-desktop-home.png` | Harvest dashboard (`/cosecha`) in a desktop browser |
| `web-desktop-week.png` | One week: kilos per day and per picker (`/cosecha/semana/:lunes`) |
| `web-desktop-account.png` | A picker's profile and balance (`/empleados/:id`) |
| `web-desktop-payroll.png` | Crew payroll (`/nomina`) |
| `web-desktop-crops.png` | Harvest per crop and lot (`/cosecha/cultivos`) |
| `web-phone-weigh.png` | Recording a weighing on a phone (`/cosecha/recoleccion`) |
| `web-phone-week.png` | Kilos per picker and day, on a phone |
| `web-phone-account.png` | A picker's balance, on a phone |
| `web-phone-crops.png` | Harvest per lot and week, on a phone |
| `web-phone-home.png` | Harvest dashboard, on a phone |

The landing (`apps/web/public/landing/app/`) uses JPEG/PNG versions of the same
captures.

## How they were made

1. `npm run dev` in `apps/web` with the mock API (`VITE_USE_MOCKS=true`).
2. In one browser page (the mock keeps its data in memory, so no reloads):
   sign up a new farm, open **Configuración → Cargar datos de demostración**,
   and add a few advances. Navigate with client-side routing.
3. Capture at 1440×900 (desktop) and 390×844 (phone) at 2× with Playwright,
   hiding the «Datos de prueba» banner.
4. Frame them: a browser window with the farm's address
   (`laesperanza.bascula.engp.io`) for desktop, a phone with a mobile-browser
   address bar for phone.
