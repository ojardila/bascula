/**
 * «Cargar datos de demostración»: six pickers, two lotes and four weeks of
 * weighings, so somebody trying Báscula sees full screens instead of empty
 * ones. The phone had this button since Sprint 1.
 *
 * ONLY ON AN EMPTY FARM. Demo people mixed into a real payroll would be paid
 * on a Saturday by somebody who did not read the names, so the loader refuses
 * outright when the farm already has anybody or any work on it. There is no
 * "remove demo data" because there is nothing real to separate them from.
 *
 * Everything goes through the same API calls the screens use, with ids minted
 * here, so the server applies every rule it applies to a person typing.
 * Weighings carry the note «Demostración».
 */
import { api } from "../../api/endpoints";
import { addDays, mondayOf, parseDay } from "../../lib/dates";
import { uuidv7 } from "../../lib/uuid";
import { pickHarvestActivity } from "../workrecords/planilla";
import type { Activity, Plot, Worker } from "../../api/types";

export const DEMO_NOTE = "Demostración";

const PEOPLE: Array<[string, string]> = [
  ["María", "Gómez"],
  ["Juan", "Pérez"],
  ["Ana", "Rodríguez"],
  ["Pedro", "Ramírez"],
  ["Luisa", "Torres"],
  ["Carlos", "Muñoz"],
];

const LOTES: Array<{ name: string; areaHa: number }> = [
  { name: "El Alto", areaHa: 2.5 },
  { name: "La Cañada", areaHa: 1.8 },
];

/** $1.000 por kilo, in cents. The price the landing's example uses. */
const PRICE_CENTS = 1_000_00;
const WEEKS = 4;

export class FarmNotEmptyError extends Error {
  constructor() {
    super("La finca ya tiene empleados o labores. Los datos de demostración solo se cargan en una finca vacía.");
    this.name = "FarmNotEmptyError";
  }
}

export async function farmIsEmpty(): Promise<boolean> {
  const [workers, records] = await Promise.all([
    api.listWorkers({ status: "all" }),
    api.listWorkRecords({ status: "all" }),
  ]);
  return workers.length === 0 && records.length === 0;
}

/** Deterministic kilos, so two farms loaded on the same day look alike. */
function kilos(person: number, day: number): number {
  const base = [118, 96, 84, 104, 72, 90][person % 6];
  const wobble = ((person * 7 + day * 13) % 23) - 11;
  return Math.max(20, base + wobble + (day % 3) * 3);
}

export interface DemoProgress {
  done: number;
  total: number;
}

export async function loadDemoData(
  today: string,
  onProgress?: (p: DemoProgress) => void,
): Promise<{ workers: number; weighings: number }> {
  if (!(await farmIsEmpty())) throw new FarmNotEmptyError();

  // The harvest activity every farm is born with; created only if it is gone.
  let activity: Activity | null = pickHarvestActivity(await api.listActivities({ status: "active" }));
  if (!activity) {
    activity = await api.createActivity({
      id: uuidv7(),
      name: "Recolección",
      category: "cosecha",
      payMode: "work_unit",
      workUnit: "kg",
      rateSource: "weekly_price",
    });
  }

  const cafe =
    (await api.cropTypes()).find((c) => /caf[eé]/i.test(c.name)) ?? (await api.createCropType("Café"));

  let plots: Plot[] = await api.listPlots({ status: "active" });
  if (plots.length === 0) {
    plots = [];
    for (const l of LOTES) {
      plots.push(
        await api.createPlot({
          id: uuidv7(),
          name: l.name,
          department: "Caldas",
          municipality: "Chinchiná",
          areaHa: l.areaHa,
          crops: [{ id: uuidv7(), cropTypeId: cafe.id, varietyId: null, areaHa: l.areaHa, plantedAt: null }],
        }),
      );
    }
  }

  const workers: Worker[] = [];
  for (let i = 0; i < PEOPLE.length; i++) {
    const [name, lastName] = PEOPLE[i];
    workers.push(
      await api.createWorker({
        id: uuidv7(),
        name,
        lastName,
        documentType: "CC",
        documentNumber: String(900_000_001 + i),
        phone: "",
      }),
    );
  }

  // The last four weeks, Monday to Saturday, up to today.
  const thisMonday = parseDay(mondayOf(today));
  const firstMonday = addDays(thisMonday, -7 * (WEEKS - 1));
  const days: string[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const monday = addDays(firstMonday, 7 * w).toISOString().slice(0, 10);
    await api.setWeekPrice(monday, PRICE_CENTS);
    for (let d = 0; d < 6; d++) {
      const day = addDays(firstMonday, 7 * w + d).toISOString().slice(0, 10);
      if (day <= today) days.push(day);
    }
  }

  const jobs: Array<() => Promise<unknown>> = [];
  days.forEach((day, di) => {
    workers.forEach((worker, wi) => {
      // Not everybody comes every day: a real week has holes in it.
      if ((wi + di) % 7 === 5) return;
      const plot = plots[(wi + Math.floor(di / 3)) % plots.length];
      jobs.push(() =>
        api.createWorkRecord({
          id: uuidv7(),
          activityId: activity!.id,
          workerId: worker.id,
          quantity: kilos(wi, di),
          dateFrom: day,
          dateTo: day,
          plotIds: [plot.id],
          plotCropIds: plot.crops.map((c) => c.id),
          note: DEMO_NOTE,
        }),
      );
    });
  });

  let done = 0;
  const total = jobs.length;
  onProgress?.({ done, total });
  // Four at a time: fast enough, and gentle on a farm's connection.
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await job();
        done += 1;
        onProgress?.({ done, total });
      }
    }),
  );
  return { workers: workers.length, weighings: total };
}
