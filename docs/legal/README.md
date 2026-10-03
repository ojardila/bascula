# Legal templates

**These are technical drafts.** They are built on top of Colombia's
Ley 1581 de 2012 and Decreto 1377 de 2013, but they are **not legal
advice**. A licensed Colombian lawyer must review each of them before
any party signs it.

Each document is in Spanish because that is the language in which the
parties sign it; the surrounding engineering docs stay in English.

- **[Contrato de encargo del tratamiento](dpa-encargo-tratamiento.md)**
  — signed between the farm (`Responsable del Tratamiento`) and the
  operator of Bascula (`Encargado del Tratamiento`) at onboarding.
  Follows Art. 24 and 25 of Decreto 1377 de 2013 (transmission to an
  encargado). Signup does not show it or record its acceptance today
  ([pending](../data-protection.md#what-is-pending)); it is signed
  outside the platform.
- **[Aviso de privacidad para trabajadores](aviso-privacidad-trabajador.md)**
  — the privacy notice the farm hands to the worker at hiring, with
  the signed-authorisation block the farm keeps as proof of the Art. 9
  authorisation. _Added in a separate PR._
- **[Términos de servicio](terminos-de-servicio.md)** — terms of use
  the farm accepts at signup. Signup does not record that acceptance
  yet ([pending](../data-protection.md#what-is-pending)). _Added in a
  separate PR._

The technical annex that both the DPA and the terms of service point
at is [`docs/data-protection.md`](../data-protection.md).

## Licence

The files in this directory are drafts of legal agreements, not software,
and are released under **Creative Commons Attribution 4.0 International**
(`SPDX-License-Identifier: CC-BY-4.0`). The licence text is at
[`LICENSES/CC-BY-4.0.txt`](../../LICENSES/CC-BY-4.0.txt).

Anyone — a farm, a competing operator, a lawyer putting a template in a
client folder, another coffee project — may copy and adapt these drafts
for any purpose including a commercial one, as long as attribution to
this repository and its copyright holder is preserved and any changes
are indicated. The templates are provided as-is with no warranty, and
they do not constitute legal advice; a licensed Colombian lawyer must
review them before any party signs them.

The code elsewhere in the repository stays under the MIT licence
declared in the root [`LICENSE`](../../LICENSE) file.
