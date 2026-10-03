// Fixture for .semgrep/bascula-ts.yml: `semgrep --test .semgrep`.
declare const kilos: number;
declare const rateCents: number;
declare const raw: string;

// ruleid: bascula-cents-without-round
const totalCents = kilos * rateCents;
// ok: bascula-cents-without-round
const roundedCents = Math.round(kilos * rateCents);
// ok: bascula-cents-without-round
const area = kilos * 2;
// ruleid: bascula-cents-without-round
let halfMinor = rateCents / 2;

// ruleid: bascula-parsefloat-money
const price = parseFloat(rawPrice);
// ok: bascula-parsefloat-money
const weight = parseFloat(rawKilos);

export { totalCents, roundedCents, area, halfMinor, price, weight, raw };
