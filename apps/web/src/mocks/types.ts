/** Request bodies the mock reads. Re-exported from the wire types. */
export type {
  Activity,
  ActivityInput,
  DeductionInput,
  LedgerEntry,
  PaymentInput,
  Plot,
  PlotInput,
  SignupRequest,
  Worker,
  WorkerInput,
  WorkRecord,
  WorkRecordInput,
} from "../api/types";

import type { SignupRequest } from "../api/types";

export interface MockRequestBody {
  signup: SignupRequest;
  login: { email: string; password: string; farmId?: string };
}
