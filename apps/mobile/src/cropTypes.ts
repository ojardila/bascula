// Crop-type presets. Selecting one prefills the measurement unit, the yield
// unit (used to express "how much each picker collected") and a suggested
// cost per unit. Everything remains editable afterwards in the Settings tab.
export interface CropPreset {
  key: string;
  label: string;
  icon: string; // MaterialCommunityIcons name
  unit: string; // measurement unit for a pickup, e.g. "kg", "racimo"
  yieldUnit: string; // yield expression, e.g. "kg por recolector"
  defaultCost: number; // suggested general cost per unit
}

export const CROP_PRESETS: CropPreset[] = [
  { key: "cafe", label: "Café", icon: "coffee", unit: "kg", yieldUnit: "kg por recolector", defaultCost: 800 },
  { key: "cacao", label: "Cacao", icon: "seed-outline", unit: "kg", yieldUnit: "kg por recolector", defaultCost: 1200 },
  { key: "platano", label: "Plátano", icon: "fruit-watermelon", unit: "racimo", yieldUnit: "racimos por recolector", defaultCost: 1500 },
  { key: "aguacate", label: "Aguacate", icon: "fruit-pear", unit: "kg", yieldUnit: "kg por recolector", defaultCost: 1000 },
  { key: "naranja", label: "Naranja", icon: "fruit-citrus", unit: "kg", yieldUnit: "kg por recolector", defaultCost: 600 },
  { key: "cana", label: "Caña", icon: "grass", unit: "tonelada", yieldUnit: "toneladas por recolector", defaultCost: 90000 },
  { key: "custom", label: "Otro", icon: "sprout", unit: "unidad", yieldUnit: "unidades por recolector", defaultCost: 0 },
];

export const DEFAULT_PRESET = CROP_PRESETS[0];

export function presetByKey(key: string): CropPreset {
  return CROP_PRESETS.find((p) => p.key === key) ?? DEFAULT_PRESET;
}
