# Usability review

Three evaluators used the product as three different people would: the owner who
wants to know how his harvest is going, the weigher standing at the scale with
gloves on, and one who read every word and every error message in both clients.

None of them are developers here. They were asked to say where they got lost,
not whether the code is good.

## The five that hurt most

### 1. There is no way to set the week's price for a kilo

The endpoint exists — `PUT /v1/prices/weeks/{monday}` is in the client — and no
screen calls it. The console can read the weekly price and cannot set it.

Worse than missing: it has a trap. Looking for the field, an owner presses
`Precio fijo`, and there the price appears. Typing a new number and saving
changes **how all coffee picking is paid**, cutting it loose from the weekly
price the phone still uses. Nothing warns them. They believe they raised this
week's price.

### 2. "How much do I owe her" has three answers, and the loudest is wrong

The worker's profile shows **$184,500** in the largest type on the screen. The
real figure is **$338,100** — the rest is picking whose price is not fixed yet,
in small type below. The true number appears only inside the pay screen, so an
owner who wants to *know* without *paying* never sees it.

Meanwhile the employee list shows a dash in every SALDO cell and totals it as
**$0**, while the dashboard says **$334,500**. Three screens, three answers. To
somebody who is not a programmer that is not a bug, it is the program lying —
and after that they believe none of the figures.

### 3. The safety is exactly backwards

| Action | Reversible | Asks first |
|---|---|---|
| **Pay $338,100** | **No** — it is written to the ledger | **No. One click.** |
| Deactivate an employee | **Yes** | **Yes**, red dialog |

The only red confirmation dialog in the console guards the action that can be
undone. The one that moves money and cannot be undone is a single green button —
and green means go.

### 4. A weighing put on the wrong person cannot be fixed

There is no screen on the phone that reassigns or deletes an ordinary weighing.
The only way in is the review dialog, and that lists only weighings that tripped
an anomaly rule — and the right weight on the wrong person trips nothing. The
recent-activity rows are not tappable. The weigher sees the mistake, with the
queue watching, and there is no path. Someone is paid short and he is the one who
has to explain it.

Alongside it, the change with the best effort-to-benefit ratio in the whole
review: the plot is cleared after every save. Twenty people in one plot, and he
picks it again two hundred times a day.

### 5. An empty screen says "there is none" when it means "I could not load it"

The settlements page states, as a fact, that nothing has ever been settled on
this farm — and prints a blank payroll sheet — when what happened is that some
of the ledger reads failed and were turned into empty lists. Inventory shows a
table with headers and nothing under them. The dashboard reads $0 while it is
still loading.

The pattern is already solved, well, inside this repository: the harvest module
separates *no permission*, *failed*, *loading* and *empty* into four branches and
writes each one. It was never carried back to the older screens.

## The words

The product uses vocabulary that came from the design, not from the farm. Some
of it is right and some is a wall.

**Right, keep them:** liquidar, jornal, cuadrilla, planilla, pesada, anticipo,
bruto, bodega, lote, lata. Somebody who knows the work chose these.

**Wrong, and they matter:**

| On screen | What happens | What a grower says |
|---|---|---|
| **Liquidar** | To him, *liquidar* a worker means to dismiss and settle up with them. Here it means closing the week. It means nearly the opposite of what he thinks — but it is also the word on the printed slip, so it stays. | keep, and gloss it |
| **Avance** vs **Anticipo** | The same money, two names, and both are printed | anticipo |
| **Parcela** vs **Lote** | The same piece of land, two names. The web says one, the phone says the other, and the web's own first field says "lote" | lote |
| **Unidad de trabajo** | This is the button that decides *how someone is paid*, written in the language of a database column | **a destajo**, por kilo, al jornal |
| **Devengo, reverso** | Accountancy and programming. Nobody says them | lo que se ganó · corregir |
| **Provisional / estimado / precio de la semana** | Three names for one state, one per screen | provisional |
| **Placa** | In Colombia a *placa* is a number plate on a car | carné |

**Destajo** is the word coffee picking is paid by in Colombia, and it appears
nowhere in the product.

## What is on the screen and should not be

Two developer notices sit above every page — one naming an environment variable
and a file — and on a phone they eat 520 of the first 844 pixels. The employee
form carries a ticket code, the word *sprint*, and *habeas data*. A payment
receipt is headed by a UUID, which is the number an owner would read out if
somebody disputed it.

Eight error codes still reach the screen in English, including the one an owner
sees when they try to remove themselves as owner.

## What must be protected

The reviewers were asked to say what is good, because it is easier to break than
to build.

**The crew payroll screen is the best thing in the console.** Two numbered steps
in the order a Saturday actually happens, tick boxes for who did not come, a
button that says *review and…* so nothing happens yet, and a confirmation that
lists every person by name. It is the model the single payment should copy.

**"It is not zero: it is that we do not know."** The phone will not print a
balance it has never received, and the type has no numeric field for that state,
so a screen that forgets to handle it fails to compile rather than printing a
quiet zero. It is the distinction that saves the most money and almost no
software makes it.

**The message when a figure moves under you.** *When you opened this screen it
was $148,400; it is now $151,200 because two more weighings came in. Nothing was
recorded.* It says what happened, why, what did not happen, and what to do — and
it refuses to invent the cause when the server could not say.

**Red is only ever used for conflicts**, on the phone. That discipline is what
makes red mean something.

**And the honesty.** *Days with no picking do not appear: the farm did not work,
it did not pick zero.* *This says nothing about your work.* *Notes never leave
this farm.* Somebody thought about the dignity of the person being measured.

The problem is not that the product explains too little. It explains before it
answers. Answer first, explain after.
