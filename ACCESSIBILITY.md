# Accessibility

Bascula is used on tablets and phones in coffee farms, often outdoors in
bright sun, and often by workers whose first contact with a touch screen is
this app. Accessibility here is not a legal checkbox; it is whether the
tool works at all for the people who use it.

## Commitment

- **WCAG 2.1 level AA** on every screen a worker, weigher, admin or
  accountant sees. Level A is the floor; AA is what we test for.
- **Spanish, plain.** Every string a farm worker reads is in Spanish and
  stays below the reading level a `bachiller` can read fast. The rest of
  the code — commits, PRs, server messages, developer docs — is in
  English (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **One hand, outdoors, with gloves on.** Big tap targets, enough contrast
  to read in sunlight, no gesture that requires two fingers.

## Supported environments

- **The web app** (`apps/web`) is the one product, used on phones,
  tablets and computers. Supported browsers are current Chrome on Android
  and Safari on iOS for phones, and current desktop browsers for the
  office screens. Automated checks run in jsdom (vitest with axe-core);
  there is no real-browser test matrix yet.
- **Language:** the worker-facing screens are in Spanish only.
- **Assistive technology:** keyboard reachability is covered per screen
  in component tests;
  screen readers are not measured yet (see Known limitations).

## What is in the repo today

- An **axe-core** assertion for screen-level tests
  (`apps/web/src/test/a11yHelper.ts`). Use it with
  `await expectNoAxeViolations(container)` in a vitest file. The scope is
  `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `best-practice`;
  `color-contrast` runs separately (jsdom cannot compute styles, so
  contrast is a Playwright check).
- A **palette-contrast test** (`apps/web/src/test/a11yPaletteContrast.test.ts`)
  that fails if the design system's text colors drop below 4.5:1 against
  their backgrounds.
- A **heading-order test** (`apps/web/src/test/a11yHeadingOrder.test.tsx`)
  that walks every rendered screen and fails if an `h1 → h3` jump exists.
- An **aria-on-generics test** (`apps/web/src/test/a11yAriaOnGenerics.test.tsx`)
  that fails when a role is set on an element the semantics already cover,
  which is the usual way an aria attribute drifts out of sync with what the
  element actually does.
- A **table-headers test** (`apps/web/src/test/a11yTableHeaders.test.tsx`)
  that fails if a `<table>` ships without `<th scope>`.

The invariants these tests pin are the ones that are easy to break in a
pull request without noticing. If one goes red, the fix is almost always
to adjust the component, not the test.

## What a pull request owes

The PR template's checklist line "Tests added or updated, and CI is green"
covers accessibility too. In practice, for the web app:

- A new screen renders through `expectNoAxeViolations` in its component
  test, inside the production providers (theme, router, auth, landmarks).
- A new interactive element is reachable by `Tab` and triggers on
  `Enter` / `Space`; the test uses `userEvent.tab()` and
  `userEvent.keyboard`, not `fireEvent.click`.
- A new piece of text that a worker reads is plain Spanish; the English
  version only exists for the admin and accountant surfaces when the role
  policy says so.
- A new color is run through the palette-contrast test before it goes
  into the theme.
- A new icon that is the only cue for an action gets an `aria-label` or a
  visible text label; a decorative icon gets `aria-hidden="true"`.

## Reporting a problem

- A bug a worker hits on a farm: open an issue on
  [`ojardila/bascula`](https://github.com/ojardila/bascula/issues) with
  the role, the screen and what did not work. A screenshot helps; do not
  include real worker names, cédulas or farm names (see
  [SECURITY.md](SECURITY.md) for how we handle data).
- A finding that lets one farm see another's data, or that lets a worker
  reach data they should not: report it privately through the
  [Security tab](https://github.com/ojardila/bascula/security), not an
  issue. See [SECURITY.md](SECURITY.md).
- A translation that reads badly in Spanish: open an issue with the
  current wording and the one that would be clearer. Pull requests are
  welcome; a one-word fix is a valid PR.

## Known limitations

- Playwright-level contrast is not wired to CI yet; the vitest check only
  covers theme tokens, not the rendered page.
- A keyboard-only pass through the full worker flow (login → pesar → firma
  del día) has not been recorded; the current coverage is per-screen axe
  plus the heading-order and aria-on-generics tests.
- Screen-reader coverage (TalkBack on Android, VoiceOver on iOS) is not
  measured. The axe assertions are a floor, not a substitute.

Each of these is tracked as its own issue when the work is scheduled, so
this document reflects the state of the repo on `master` today.
