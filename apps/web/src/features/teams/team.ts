// SPDX-License-Identifier: MIT
/**
 * «Equipos»: a pair or a family that picks into one sack and is paid as one
 * account (docs/use-cases/teams.md). The team is the payee; its members are
 * real people with no personal weighings or balance while they are in it.
 */
import type { Worker } from "../../api/types";

export function isTeam(w: Pick<Worker, "kind"> | null | undefined): boolean {
  return w?.kind === "equipo";
}

/** In a team today: weighed and paid through it, not on their own. */
export function inTeam(w: Pick<Worker, "team"> | null | undefined): boolean {
  return !!w?.team;
}

export function memberCount(w: Pick<Worker, "members">): number {
  return w.members?.length ?? 0;
}

/** «Equipo de 2». */
export function teamSize(n: number): string {
  return n === 1 ? "Equipo de 1" : `Equipo de ${n}`;
}

/** «Yorman, Sergio» — first names: that is what people call each other. */
export function memberNames(w: Pick<Worker, "members">): string {
  return (w.members ?? []).map((m) => m.name).join(", ");
}

/** The line under a team's name: «Equipo de 2 · Yorman, Sergio». */
export function teamLine(w: Pick<Worker, "members">): string {
  const names = memberNames(w);
  return names ? `${teamSize(memberCount(w))} · ${names}` : teamSize(memberCount(w));
}

/**
 * Who can be put on the scale: everybody except people who are in a team
 * (they weigh with the team). A team without members can still be weighed.
 */
export function weighable<T extends Pick<Worker, "team">>(workers: T[]): T[] {
  return workers.filter((w) => !inTeam(w));
}

/** Text a search should match for a team: its name plus its members' names and tags. */
export function teamSearchText(w: Worker): string {
  return (w.members ?? []).map((m) => `${m.name} ${m.lastName ?? ""} ${m.tag ?? ""}`).join(" ");
}

