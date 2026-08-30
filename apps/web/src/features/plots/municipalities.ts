/**
 * ── A MUNICIPALITY THAT IS NOT IN THAT DEPARTMENT ────────────────────────
 *
 * The plot form came with "Caldas" filled in from the factory and the
 * municipality was free text, so it silently accepted "Caldas · Pitalito".
 * Pitalito is in Huila. Nobody gets Pitalito wrong by typing it: they get it
 * wrong by not touching the department, because it was already filled in and
 * looked right.
 *
 * Two fixes, and this is the second. The first is in the form: the department
 * no longer comes prefilled, you have to choose it.
 *
 * ── THIS TABLE IS DELIBERATELY PARTIAL, AND ONLY WARNS ───────────────────
 *
 * Colombia has 1,100 municipalities and this is not a register. These are the
 * coffee-growing municipalities the farm next door would name, and it exists
 * for exactly one thing: when somebody types one that IS in the table under a
 * department that is not its own, say so. It never blocks and never complains
 * about a name it does not know, which is half the country.
 *
 * That asymmetry is what makes it safe to have only half of: a false positive
 * is impossible —it only speaks about names it knows— and a false negative is
 * a municipality it simply says nothing about, which is exactly what used to
 * happen with all of them.
 */

/** Municipality -> department. Keys are lowercased and stripped of accents. */
const BY_MUNICIPALITY: Record<string, string> = {};

const TABLE: Record<string, string[]> = {
  Caldas: [
    "Manizales", "Chinchiná", "Palestina", "Villamaría", "Neira", "Aranzazu",
    "Salamina", "Aguadas", "Pácora", "Manzanares", "Pensilvania", "Riosucio",
    "Supía", "Anserma", "Risaralda", "Belalcázar", "Viterbo", "La Merced",
    "Marquetalia", "Samaná", "Marulanda", "Filadelfia", "San José", "Victoria",
  ],
  Quindío: [
    "Armenia", "Calarcá", "Circasia", "Filandia", "Génova", "La Tebaida",
    "Montenegro", "Pijao", "Quimbaya", "Salento", "Buenavista", "Córdoba",
  ],
  Risaralda: [
    "Pereira", "Dosquebradas", "Santa Rosa de Cabal", "Marsella", "Belén de Umbría",
    "Apía", "Santuario", "Quinchía", "Guática", "La Celia", "Balboa", "Pueblo Rico",
  ],
  Huila: [
    "Neiva", "Pitalito", "Garzón", "La Plata", "Gigante", "Campoalegre",
    "Acevedo", "San Agustín", "Isnos", "Timaná", "Suaza", "Palestina",
    "Oporapa", "Saladoblanco", "Tarqui", "Guadalupe",
  ],
  Antioquia: [
    "Medellín", "Andes", "Jardín", "Jericó", "Ciudad Bolívar", "Salgar",
    "Concordia", "Betania", "Fredonia", "Támesis", "Venecia", "Amagá",
    "Santa Bárbara", "Urrao", "Betulia", "Hispania", "Angelópolis",
  ],
  Tolima: [
    "Ibagué", "Chaparral", "Planadas", "Rioblanco", "Líbano", "Fresno",
    "Villahermosa", "Anzoátegui", "Cajamarca", "Roncesvalles", "Santa Isabel",
    "Herveo", "Casabianca", "Icononzo",
  ],
  Nariño: [
    "Pasto", "La Unión", "Buesaco", "Sandoná", "Consacá", "La Florida",
    "Chachagüí", "Taminango", "San Lorenzo", "Arboleda", "Colón", "Linares",
  ],
  Cauca: [
    "Popayán", "Inzá", "Piendamó", "Cajibío", "El Tambo", "Timbío",
    "Morales", "Suárez", "Santander de Quilichao", "Caldono", "Silvia", "Balboa",
  ],
  "Valle del Cauca": [
    "Cali", "Sevilla", "Caicedonia", "Trujillo", "Riofrío", "El Cairo",
    "Argelia", "Versalles", "Restrepo", "Dagua", "Ginebra", "El Águila",
  ],
  Santander: [
    "Bucaramanga", "San Gil", "Socorro", "Rionegro", "Girón", "Piedecuesta",
    "Charalá", "Ocamonte", "Suaita", "Vélez", "Landázuri", "El Playón",
  ],
  Cundinamarca: [
    "Bogotá", "Fusagasugá", "Viotá", "Pacho", "La Vega", "Silvania",
    "Tibacuy", "Pasca", "Arbeláez", "Gachalá", "Yacopí", "Caparrapí",
  ],
};

/**
 * NAMES THAT GENUINELY BELONG TO TWO DEPARTMENTS.
 *
 * "Palestina" is in Caldas and also in Huila; "Balboa" in Risaralda and in
 * Cauca; "Risaralda" is both a municipality of Caldas and a department. About
 * those nothing can be said, so nothing is: they are pulled out of the table
 * instead of inventing a rule that would be right half the time.
 */
const AMBIGUOUS = new Set(["palestina", "balboa", "risaralda", "colon", "argelia", "san jose"]);

/** Lowercased and unaccented, so "Chinchiná" and "chinchina" are the same. */
export function foldName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

for (const [department, towns] of Object.entries(TABLE)) {
  for (const town of towns) {
    const key = foldName(town);
    if (AMBIGUOUS.has(key)) continue;
    // A name that shows up twice without being in AMBIGUOUS is a bug in this
    // table, not the user's: it goes quiet rather than accusing anybody.
    if (key in BY_MUNICIPALITY && BY_MUNICIPALITY[key] !== department) {
      AMBIGUOUS.add(key);
      delete BY_MUNICIPALITY[key];
      continue;
    }
    BY_MUNICIPALITY[key] = department;
  }
}

/**
 * The department that municipality belongs to, when the table knows for
 * certain. `null` for everything else — most of the country, and that is fine.
 */
export function departmentOfMunicipality(municipality: string): string | null {
  return BY_MUNICIPALITY[foldName(municipality)] ?? null;
}

/**
 * `null` when there is nothing to say. A sentence when the municipality typed
 * belongs, for certain, to another department. It never stops a save: whoever
 * is standing on the farm knows where they are better than this table does.
 */
export function departmentMismatch(
  department: string,
  municipality: string,
): string | null {
  if (!department.trim() || !municipality.trim()) return null;
  const real = departmentOfMunicipality(municipality);
  if (!real || foldName(real) === foldName(department)) return null;
  return `${municipality.trim()} queda en ${real}, no en ${department}. Revise el departamento.`;
}

export const DEPARTMENTS_WITH_TOWNS = Object.keys(TABLE);
