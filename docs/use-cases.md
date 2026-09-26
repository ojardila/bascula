# Use cases

How a coffee farm uses Báscula day to day. The screens are in plain Spanish
for people around fifty who don't live in software, so every flow below has
one obvious action and big touch targets, on a phone browser or a computer.

## The daily workflow in one paragraph

Pickers (recolectores) harvest coffee every day in one or several lots
(lotes). They bring the coffee back to the farm or the collection point
(centro de acopio), where it is weighed. Each day a harvest sheet (planilla de
recolección) records **person + lot + kilos**. Pickers are paid **per kilo**,
at the week's price.

## 1. Weigh-in when a picker comes back from a lot

**Who:** the weigher (pesador) or the administrator, at the scale, usually on
a phone, often with no signal.
**Screen:** Cosecha → «Registrar una recolección» (`/cosecha/recoleccion`).

1. Pick the person (type a few letters of the name).
2. The lot is already chosen: the screen remembers the last lot used on this
   device. Tap another lot button if the person comes from a different one.
3. The day is «Hoy» by default («Ayer» / «Otro día» for late entries).
4. Type the kilos on the big numeric keypad and tap «Guardar pesada».
5. The screen clears the person and the kilos and keeps the lot and the day,
   ready for the next person in line. The last weighings are listed with
   «Deshacer».

Rules:
- A person can be weighed **several times a day** (several trips, or trips
  from different lots). Each weighing is its own work record.
- A weight above 120 kg asks for confirmation (the typed extra zero).
- **No signal:** the weighing is kept on the device and uploads on its own
  when the connection returns («N pesadas por subir»). Each weighing carries
  an id minted on the device, so a resend is never counted twice.

## 2. Enter a weekly or daily planilla from paper

**Who:** the owner or the administrator, often on Saturday, from the paper
sheet filled during the week. Needs a connection.
**Screen:** Cosecha → «Registrar la semana» (`/cosecha/registrar-semana`).

1. Choose the week (arrows; this week by default) and the lot (remembered on
   the device).
2. Type the kilos of each person for each day. Blank means the person did not
   pick on that lot that day.
   - On a computer: a grid of people × days with totals per person and per day.
   - On a phone: one day at a time (seven big day buttons) with one big box
     per person.
3. «Guardar la semana» shows how many changes and the week's total, and asks
   for confirmation. Then it says «Listo. Se guardaron N pesadas.»

Rules:
- One sheet is one lot: a person who picked in two lots on the same day is
  entered on each lot's sheet.
- A cell that already adds up several weighings (from case 1) shows the sum
  and is read-only; each weighing is corrected on its own in Labores.
- Settled (liquidated) weighings and future days cannot be changed.
- A single day for the whole crew is also available at
  `/labores/planilla?modo=dia`.

## 3. The owner checks the harvest

**Who:** the owner, every day, on a phone or a computer.
**Screen:** Cosecha (`/cosecha`).

- This week in big figures: kilos, value (only for roles that may see money)
  and pickers, one sentence about last week, and kilos per day.
- The two registration buttons from cases 1 and 2.
- «Ver más detalles» (`/cosecha/detalles`) for the season curve, week detail
  (kilos per picker and day, or per crop), per crop, the yield index and the
  review of suspicious weighings.
- The same questions can be asked to ChatGPT, Claude or another assistant
  through the read-only MCP server, limited to what the user's role may see.

## 4. Pay per kilo

**Who:** the owner or the administrator, usually at the end of the week.
**Screens:** Precio de la semana (`/precio-semana`), Pagos, Empleados → Pagar.

1. Set the week's price per kilo (or leave the farm's base price).
2. The value of each weighing is kilos × the week's price. Until the week is
   settled the value is marked «provisional».
3. Pay the whole crew (Pagos) or one worker (Empleados → Pagar): the screen
   shows the work not yet settled, advances and deductions, and the balance.
4. Record what is handed over (full or partial). The settlement freezes the
   price; advances, deductions, payments and adjustments go in an append-only
   ledger. A receipt can be printed or sent by WhatsApp.
