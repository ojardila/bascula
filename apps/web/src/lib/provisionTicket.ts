/**
 * The provision ticket: what signup (or the super-admin console) hands back
 * with a new farm, and the only thing that opens that farm's
 * `/v1/farms/{slug}/provision-status` and `/ready-email`. Without it the API
 * answers 404, exactly as for a slug nobody registered, so the waiting screen
 * cannot be used to look up other people's farms.
 *
 * Kept in localStorage per slug so a reload of `/preparando/:slug` keeps
 * working. It expires on the server after a week.
 */
const PREFIX = "bascula.provisionTicket.";

export function saveProvisionTicket(slug: string, ticket: string | null | undefined): void {
  if (!slug || !ticket) return;
  try {
    localStorage.setItem(PREFIX + slug.toLowerCase(), ticket);
  } catch {
    // Private mode or full storage: the screen still works until reload.
    memory.set(slug.toLowerCase(), ticket);
  }
}

export function loadProvisionTicket(slug: string): string | null {
  const key = slug.toLowerCase();
  try {
    return localStorage.getItem(PREFIX + key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

/** The header the API reads the ticket from. */
export const PROVISION_TICKET_HEADER = "X-Provision-Ticket";

export function provisionTicketHeaders(slug: string): Record<string, string> | undefined {
  const t = loadProvisionTicket(slug);
  return t ? { [PROVISION_TICKET_HEADER]: t } : undefined;
}

const memory = new Map<string, string>();
