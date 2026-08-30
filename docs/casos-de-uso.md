# Use cases

Written by the owner before this work started. They are the source of truth for
scope: today's mobile app covers only a small part of this.

Interface references the owner pointed at for the plot module (*Parcelas*):
cropti.com and farmlogs.com.

> A note on vocabulary. This is the owner's document and his words are the
> product's words. Where a Spanish term is also what the interface says, it is
> kept in parentheses: **Parcela** (plot) and **Labor** (work record) are the
> two that matter most.

## Conventions common to every case

- The actor is the **Farm Administrator**, authenticated and holding the
  privilege for that module.
- On entering any module without the privilege, the system says what is missing
  and takes the user out of the module.
- On save, the system validates the required fields and, if any are missing,
  says **which** and **why**, and lets the user back into the form.
- **Delete never deletes**: it marks the record inactive.

---

## 1. Plot management (*Gestión de Parcelas*)

### RSP-001 Register a Parcela

Fields:

*Plot information*
- Plot name (*nombre del lote*) — string(80), required
- Total area in hectares — double, required

*Location*
- Department — string(80), required
- Municipality — string(80), required
- Map — polygon (GIS data)

*Crop information*
- Crop type — string(80), required (coffee, avocado, cassava…), with the option
  to add one if it does not exist
- Variety — string(80), autocomplete with the option to add one if it does not
  exist
- Button to add another crop

Exception: the system offers a coffee crop by default, ready to have a variety
selected against it.

### RSP-002 Modify a Parcela
The same fields, pre-filled with the stored values.

### RSP-003 Delete a Parcela
Asks for confirmation. On accept, the plot becomes **inactive**, not deleted.

---

## 2. Employee management (*Gestión de Empleados*)

### RSP-004 Register an Employee

*Employee details*
- Full name — string(80), required
- Identification type — string(80), required
- Identification number — string(80), required
- Photo — file, up to 5 MB

*Contact details*
- Phone — numeric(30), required
- Address, city — string(80)

**Requires internet**: before saving, the system uses the identification number
to look up the person's **work history at other farms** and any **safety
alerts**, and shows them so the user can continue or cancel. With no internet,
it creates a background-check request that syncs later.

### RSP-005 Modify an Employee
The same fields, pre-filled. Address includes city, municipality and country.

### RSP-006 Delete an Employee
Confirmation; the employee becomes **inactive**.

### RSP-007 View an Employee's profile
Shows the employee's details, the **balance owed to them**, and action buttons:
pay employee, register a debt, add a note. Plus:
- **Work records** (*Labores*): activity name, date, plots
- **Financial history**: type (debt or payment), concept, amount, date
- **Notes**: text and date

### RSP-008 Pay an Employee
Redirects to the payments module, which shows:
- List of work records: name, date, plots, value
- List of debts: description of the expense, date, value
- Total to pay
- Buttons: register debt, register work record, partial payment, full payment

On a **partial payment** it asks for the amount, validates that it is less than
the current balance, and updates the balance. On a **full payment** it leaves
the balance at zero. The system generates the **payment receipt**.

### RSP-009 Look up an Employee's history
Searches by identification type and number and shows the **public data**: the
farms where the person has worked with their periods, and the notes written
about them. If there is no information, it says so. **Postcondition: it is
recorded that this farm looked them up.**

---

## 3. Activity management (*Gestión de Actividades*)

### RSP-010 List Activities
Pulls the latest categories and activities from the public repository on the
internet. Lists them grouped by category, showing name, form of payment and the
details of its units. For example:

- Harvest → picking, paid by the kilo
- Maintenance → felling by the day, fertilising by the day

Offers a search box and the buttons "Agregar Actividad" (*add activity*) and
"Definir Precios" (*set prices*).

### RSP-011 Register an Activity
- Name — required
- Category — select, required (planting, maintenance, harvest…), with the option
  to create a new one
- Payment — select, required: **by contract**, **by time** or **by unit of
  work**

Depending on the payment:
- *Unit of work*: unit (kilos, arrobas, baskets) and price per unit
- *Unit of time*: daily (`jornal`, a day's work at a day rate), weekly,
  fortnightly, monthly or custom (quantity + unit: day, month, year), and price

### RSP-012 Modify an Activity · RSP-013 Delete an Activity
Same fields; deleting leaves the activity **inactive**.

### Setting activity prices
Still to be specified by the owner.

---

## 4. Work record management (*Gestión de Labores*)

### RSP-014 List Labores
Shows activity, form of payment, date performed, plots and crops, with a search
box and a "Registrar labor" (*register work record*) button.

### RSP-015 Register a Labor
The user picks a category and then an activity; the system shows:
- Activity name and form of payment (read only)
- Employee — required
- Units of time or of work — required
- Price — defaults to the activity's
- Date range — defaults to today, required
- Plots — required
- Crops — required

### RSP-016 Modify a Labor · RSP-017 Delete a Labor
Deleting leaves the work record **inactive**.

---

## 5. Product and inventory management (*Gestión de Productos e Inventarios*)

### RSP-018 List Products
Pulls categories and products from the public repository. Groups them by
category showing name and units in stock, with options to modify, delete and
update inventory.

### RSP-019 Register a Product
- Name — required
- Category — select (raw material, processed product…), with the option to
  create one
- Storage units — select, with the option to create one

### RSP-020 Modify a Product · RSP-021 Delete a Product
Deleting leaves the product **inactive**.

### RSP-025 Register product inventory
- Product name (not editable), units, batch, warehouse (optional), crop
- On save, **the system prints the product identification stickers**

---

## 6. Sales management (*Gestión de Ventas*)

### RSP-026 List Sales · RSP-027 Register a Sale
- Product — select, required
- Quantity — double, required
- Value — double, required
- Customer — select (e.g. a cooperative)
- Photo of the sale receipt

### RSP-028 Modify a Sale · RSP-029 Delete a Sale
Deleting leaves the sale **inactive**.

---

## 7. Expense management (*Gestión de Gastos*)

### RSP-030 List Expenses · RSP-031 Register an Expense
- Value — double
- Expense type — select: **activity** or **plot/crop**
  - If it is an activity: it is picked from the list of existing activities
  - If it is a plot/crop: the plot becomes required and the system shows the
    crops associated with that plot
- Plot and crops — optional depending on the type

### RSP-032 Modify an Expense · RSP-033 Delete an Expense
Deleting leaves the expense **inactive**.

---

## 8. Configuration (*Configuración*)

### Modify farm details
- Name, phone, size in hectares — required
- Country (select), city, address — required

### Modify work prices
Still to be specified by the owner.

### User management
List and add users. Still to be detailed.

---

## 9. Authentication and registration

### Authenticate a user · Register a farm
Both still to be specified by the owner.

---

## Tensions this document opens

Noted by the team on receiving it, to be resolved before building.

1. **Picking stops being special.** The mobile app treats weighing by the kilo
   as a first-class entity. Here it is *one activity* paid by unit of work,
   alongside felling by the day or fertilising by contract. Generalising the
   model touches the ledger, the settlements and the migration of the data that
   already exists.

2. **Parcela and cultivo are not the same thing.** Today `crops` mixes the two;
   here a plot has several crops, each with its own type and variety.

3. **RSP-004 and RSP-009 cross farms.** Looking up a worker's history at other
   farms and their "safety alerts" breaks tenant isolation and carries serious
   privacy implications: designed badly, it is a labour blacklist. What gets
   shared, who sees it and how an unfair entry is corrected are the owner's
   decisions, not the team's.

4. **GIS polygons** (RSP-001) mean PostGIS, or GeoJSON in `jsonb`.

5. **A public repository of activities and products** (RSP-010, RSP-018): a
   catalogue shared between farms that today exists nowhere.
