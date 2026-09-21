/**
 * The scale sheet: one lote, one day, kilos next to each name.
 *
 * One pesada at a time was still too many taps at the romana. The weekly
 * planilla stays at /labores/planilla. This is the ordinary morning path.
 */
import { PlanillaPage } from "./PlanillaPage";

export { pickHarvestActivity } from "./planilla";

export function RecoleccionFormPage() {
  return <PlanillaPage lockedMode="dia" />;
}
