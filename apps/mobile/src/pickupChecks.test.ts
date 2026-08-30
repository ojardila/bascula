import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldText,
  matches,
  exactTag,
  weightDoubt,
  MAX_PLAUSIBLE_WEIGHT,
} from "./pickupChecks.ts";

// ---- Finding a picker in a list of forty --------------------------------

const crew = [
  { id: 1, label: "Ana Ramírez", tag: "T12" },
  { id: 2, label: "Ana Rendón", tag: "T13" },
  { id: 3, label: "José Ñungo", tag: "" },
  { id: 4, label: "Wilson Ospina", tag: "A-7" },
];

test("the accent is not a password", () => {
  // Nobody types an accent with gloves on. «Ramirez» has to find «Ramírez».
  assert.equal(foldText("Ana Ramírez"), "anaramirez");
  assert.ok(matches(crew[0], "ramirez"));
  assert.ok(matches(crew[2], "nungo"));
});

test("two names eight pixels apart are told apart by three more letters", () => {
  // This is the whole point of the box: «Ana Ramírez» and «Ana Rendón» sit
  // next to each other in an alphabetical list of forty.
  const hits = crew.filter((p) => matches(p, "ana re"));
  assert.deepEqual(hits.map((p) => p.id), [2]);
});

test("an empty box hides nobody", () => {
  assert.deepEqual(crew.filter((p) => matches(p, "  ")).length, crew.length);
});

test("the card is matched from its start, the name from anywhere", () => {
  // A card is read off plastic and typed whole; a name arrives as whichever
  // half is remembered.
  assert.ok(matches(crew[3], "a7"), "the card, punctuation and all");
  assert.ok(matches(crew[3], "ospina"), "and the surname on its own");
  assert.ok(!matches(crew[0], "12x"));
});

test("a card typed whole skips the choosing step", () => {
  assert.equal(exactTag(crew, "T12")?.id, 1);
  assert.equal(exactTag(crew, "a-7")?.id, 4, "punctuation and case are noise");
});

test("half a card selects nobody", () => {
  // Selecting on a prefix would move the load onto somebody else halfway
  // through typing, which is the mistake this screen exists to stop.
  assert.equal(exactTag(crew, "T1"), null);
  assert.equal(exactTag(crew, ""), null);
});

test("a card two people carry is handed back, not guessed", () => {
  const twins = [
    { id: 1, label: "Ana", tag: "T9" },
    { id: 2, label: "Beto", tag: "t9" },
  ];
  assert.equal(exactTag(twins, "T9"), null, "a coin toss would put the load on the wrong person");
});

test("somebody with no card is never found by an empty one", () => {
  assert.equal(exactTag(crew, "  "), null);
  assert.ok(!matches({ label: "José Ñungo", tag: "" }, "t"), "an absent card matches nothing");
});

// ---- The zero typed twice ------------------------------------------------

const ana = { avgWeight: 78, samples: 40 };

test("250 kg from somebody who normally brings 78 is questioned", () => {
  const doubt = weightDoubt(250, ana);
  assert.deepEqual(doubt, { rule: "digit", reference: 78 });
});

test("a normal load passes without a word", () => {
  assert.equal(weightDoubt(85, ana), null);
  assert.equal(weightDoubt(78, ana), null);
  // Half as much again as usual is a good day, not a typo.
  assert.equal(weightDoubt(118, ana), null);
});

test("a picker with no history is not accused", () => {
  // Two loads is not a habit. A warning that fires on the second day of the
  // harvest is a warning that gets tapped through by Thursday.
  // 110 is three times their two recorded loads and still a weight a person
  // can carry: with a history the personal rule would fire, and it must not.
  assert.equal(weightDoubt(110, { avgWeight: 30, samples: 2 }), null);
  assert.equal(weightDoubt(90, { avgWeight: 0, samples: 0 }), null);
});

test("the impossible weight is still caught on a stranger", () => {
  // This is the rule that has to work on day one, when nobody has a history:
  // the personal one has nothing to compare against.
  assert.deepEqual(weightDoubt(850, { avgWeight: 0, samples: 0 }), {
    rule: "impossible",
    reference: MAX_PLAUSIBLE_WEIGHT,
  });
  assert.equal(weightDoubt(120, { avgWeight: 0, samples: 0 }), null, "the threshold itself passes");
});

test("when both rules fire, the one that says what to type instead wins", () => {
  // «Lo normal de Ana es 78 kg» tells somebody the number. «Nadie carga tanto»
  // only tells them they are wrong.
  assert.deepEqual(weightDoubt(850, ana), { rule: "digit", reference: 78 });
});

test("a crop whose loads really are heavy can turn the ceiling off", () => {
  // A bunch of plátano weighs more than a day of coffee. The threshold is a
  // suspicion, never a law.
  assert.equal(weightDoubt(300, { avgWeight: 0, samples: 0 }, 0), null);
});

test("nothing is asked about a weight the save button would refuse anyway", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(weightDoubt(bad, ana), null, `${bad} is a validation error, not a doubt`);
});
