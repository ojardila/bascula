/**
 * ── UN MUNICIPIO QUE NO ES DE ESE DEPARTAMENTO ───────────────────────────
 *
 * El formulario de lote traía «Caldas» puesto de fábrica y el municipio era
 * texto libre, así que aceptó sin decir nada «Caldas · Pitalito». Pitalito es
 * del Huila. Nadie se equivoca escribiendo Pitalito: se equivoca no tocando el
 * departamento, porque ya venía puesto y parecía correcto.
 *
 * Dos arreglos, y éste es el segundo. El primero está en el formulario: el
 * departamento ya no viene puesto, hay que elegirlo.
 *
 * ── ESTA TABLA ES DELIBERADAMENTE PARCIAL, Y SÓLO AVISA ──────────────────
 *
 * Colombia tiene 1.100 municipios y esto no es un padrón. Son los municipios
 * cafeteros que la finca de al lado nombraría, y existe para una sola cosa:
 * cuando alguien escribe uno que ESTÁ en la tabla bajo un departamento que no
 * es el suyo, decirlo. Nunca bloquea y nunca se queja de un nombre que no
 * conoce, que es la mitad del país.
 *
 * Esa asimetría es lo que la hace segura de tener a medias: un falso positivo
 * es imposible —sólo habla de nombres que conoce— y un falso negativo es un
 * municipio del que sencillamente no dice nada, que es exactamente lo que
 * pasaba antes con todos.
 */

/** Municipio -> departamento. Las claves van sin tildes y en minúscula. */
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
 * NOMBRES QUE ESTÁN EN DOS DEPARTAMENTOS DE VERDAD.
 *
 * «Palestina» es de Caldas y también del Huila; «Balboa», de Risaralda y del
 * Cauca; «Risaralda» es un municipio de Caldas y un departamento. De ésos no
 * se puede decir nada, así que no se dice: se sacan de la tabla en vez de
 * inventar una regla que acertaría la mitad de las veces.
 */
const AMBIGUOUS = new Set(["palestina", "balboa", "risaralda", "colon", "argelia", "san jose"]);

/** Sin tildes y en minúscula, para que «Chinchiná» y «chinchina» sean lo mismo. */
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
    // Un nombre que aparece dos veces sin estar en AMBIGUOUS es un error de
    // esta tabla, no del usuario: se calla en vez de acusar a nadie.
    if (key in BY_MUNICIPALITY && BY_MUNICIPALITY[key] !== department) {
      AMBIGUOUS.add(key);
      delete BY_MUNICIPALITY[key];
      continue;
    }
    BY_MUNICIPALITY[key] = department;
  }
}

/**
 * El departamento al que pertenece ese municipio, cuando la tabla lo sabe con
 * certeza. `null` para todo lo demás — que es la mayoría del país, y está bien.
 */
export function departmentOfMunicipality(municipality: string): string | null {
  return BY_MUNICIPALITY[foldName(municipality)] ?? null;
}

/**
 * `null` cuando no hay nada que decir. Un texto cuando el municipio escrito
 * pertenece, con certeza, a otro departamento. Nunca impide guardar: quien
 * está parado en la finca sabe dónde está mejor que esta tabla.
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
