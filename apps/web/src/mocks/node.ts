import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** The same handlers, for tests. One definition, two environments. */
export const server = setupServer(...handlers);
