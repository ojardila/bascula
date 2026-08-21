import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Prefs } from "./db";

export type Lang = "es" | "en" | "pt";

type Dict = Record<string, string>;

const es: Dict = {
  // Navigation / tabs
  "nav.home": "Inicio",
  "nav.workers": "Recolectores",
  "nav.crops": "Cultivos",
  "nav.pickup": "Recolección",
  "nav.reports": "Reportes",
  "nav.settings": "Ajustes",
  "stack.newWorker": "Nuevo recolector",
  "stack.newCrop": "Nuevo cultivo",
  "stack.registerPickup": "Registrar recolección",

  // Home
  "home.totalHarvested": "Total recolectado",
  "home.pickupsCount": "{n} recolecciones",
  "home.today": "Hoy",
  "home.thisWeek": "Esta semana",
  "home.registerPickup": "Registrar recolección",
  "home.recentActivity": "Actividad reciente",
  "home.noPickups": "Aún no hay recolecciones. Toca “Registrar recolección”.",

  // Shared labels
  "label.workers": "Recolectores",
  "label.crops": "Cultivos",
  "label.pickups": "Recolecciones",

  // People
  "people.empty": "Aún no hay recolectores. Toca + para agregar.",
  "people.tag": "placa",

  // PeopleAdd
  "peopleAdd.gallery": "Galería",
  "peopleAdd.camera": "Cámara",
  "peopleAdd.removePhoto": "Quitar foto",
  "peopleAdd.firstName": "Nombre *",
  "peopleAdd.lastName": "Apellido",
  "peopleAdd.docType": "Tipo de documento",
  "peopleAdd.docId": "Número de documento",
  "peopleAdd.rfid": "Placa / tarjeta RFID",
  "peopleAdd.rfidHelp": "La placa identifica al recolector en la báscula.",
  "peopleAdd.save": "Guardar recolector",

  // Crops
  "crops.empty": "Aún no hay cultivos. Toca + para agregar.",

  // CropAdd
  "cropAdd.type": "Tipo de cultivo *",
  "cropAdd.measuredIn": "Se mide en {unit} · {yield}",
  "cropAdd.lotName": "Nombre del lote *",
  "cropAdd.lotPlaceholder": "p.ej. {label} lote 1",
  "cropAdd.variety": "Variedad",
  "cropAdd.area": "Área sembrada (ha)",
  "cropAdd.save": "Guardar cultivo",

  // RegisterPickup
  "pickup.worker": "Recolector",
  "pickup.crop": "Cultivo",
  "pickup.noWorkers": "No hay recolectores — agrega uno primero.",
  "pickup.noCrops": "No hay cultivos — agrega uno primero.",
  "pickup.weight": "Peso ({unit})",
  "pickup.save": "Guardar recolección",
  "pickup.saved": "✅ Recolección guardada",

  // Reports
  "reports.total": "Total {unit}",
  "reports.pickups": "Recolecciones",
  "reports.toPay": "A pagar",
  "reports.pickers": "Recolectores",
  "reports.week": "Semana",
  "reports.worker": "Recolector",
  "reports.crop": "Cultivo",
  "reports.byWeek": "Recolección por semana",
  "reports.byWorker": "Recolección por recolector",
  "reports.byCrop": "Recolección por cultivo",
  "reports.unitsCollected": "{unit} recolectados",
  "reports.noPickups": "Aún no hay recolecciones registradas.",
  "reports.recent": "Recolecciones recientes",
  "reports.nothing": "Nada aún.",

  // Settings
  "settings.cropTypeTitle": "Tipo de cultivo",
  "settings.cropTypeSub": "Elige uno para cargar sus unidades por defecto",
  "settings.unitsTitle": "Unidades y costo",
  "settings.cropName": "Nombre del cultivo",
  "settings.unit": "Unidad de medida",
  "settings.unitPlaceholder": "kg, racimo, tonelada…",
  "settings.yieldUnit": "Unidad de rendimiento",
  "settings.generalCost": "Costo general por {unit}",
  "settings.generalCostHelp":
    "Este costo aplica a todas las semanas salvo que lo sobrescribas abajo.",
  "settings.saveConfig": "Guardar configuración",
  "settings.weekCostsTitle": "Costos por semana",
  "settings.weekCostsSub": "Sobrescribe el costo por unidad en semanas concretas",
  "settings.noWeeks": "Aún no hay recolecciones registradas para asignar costos por semana.",
  "settings.week": "Semana",
  "settings.costPer": "Costo por {unit}",
  "settings.add": "Añadir",
  "settings.demoTitle": "Datos de demostración",
  "settings.demoSub": "Recolectores, cultivos y 4 semanas de recolecciones",
  "settings.loadDemo": "Cargar demo",
  "settings.clearAll": "Borrar todo",
  "settings.languageTitle": "Idioma",
  "settings.languageSub": "Idioma de la aplicación",
  "settings.saved": "✅ Configuración guardada",
  "settings.demoLoaded": "✅ Datos de demo cargados",
  "settings.cleared": "🗑️ Datos borrados",
  "settings.chooseWeekCost": "Elige una semana y un costo válido",
  "settings.weekUpdated": "✅ Costo de {week} actualizado",

  // Weekly lots breakdown
  "reports.lots": "Lotes",

  // Worker detail
  "worker.performance": "Rendimiento",
  "worker.avg": "Prom. {unit}",
  "worker.days": "Días activos",
  "worker.byWeek": "Rendimiento por semana",
  "worker.byCrop": "Por cultivo",
  "worker.deletedBadge": "Inactivo",

  // Confirm delete
  "confirm.deleteWorkerTitle": "¿Eliminar recolector?",
  "confirm.deleteWorkerBody":
    "Se ocultará de la lista, pero su historial de recolección se conserva.",
  "confirm.cancel": "Cancelar",
  "confirm.delete": "Eliminar",

  "unit.default": "unidad",
};

const en: Dict = {
  "nav.home": "Home",
  "nav.workers": "Workers",
  "nav.crops": "Crops",
  "nav.pickup": "Pickup",
  "nav.reports": "Reports",
  "nav.settings": "Settings",
  "stack.newWorker": "New worker",
  "stack.newCrop": "New crop",
  "stack.registerPickup": "Register pickup",

  "home.totalHarvested": "Total harvested",
  "home.pickupsCount": "{n} pickups",
  "home.today": "Today",
  "home.thisWeek": "This week",
  "home.registerPickup": "Register pickup",
  "home.recentActivity": "Recent activity",
  "home.noPickups": "No pickups yet. Tap “Register pickup” to start.",

  "label.workers": "Workers",
  "label.crops": "Crops",
  "label.pickups": "Pickups",

  "people.empty": "No workers yet. Tap + to add one.",
  "people.tag": "tag",

  "peopleAdd.gallery": "Gallery",
  "peopleAdd.camera": "Camera",
  "peopleAdd.removePhoto": "Remove photo",
  "peopleAdd.firstName": "First name *",
  "peopleAdd.lastName": "Last name",
  "peopleAdd.docType": "Document type",
  "peopleAdd.docId": "Document id",
  "peopleAdd.rfid": "RFID tag / card",
  "peopleAdd.rfidHelp": "The tag identifies the worker at the scale.",
  "peopleAdd.save": "Save worker",

  "crops.empty": "No crops yet. Tap + to add one.",

  "cropAdd.type": "Crop type *",
  "cropAdd.measuredIn": "Measured in {unit} · {yield}",
  "cropAdd.lotName": "Plot name *",
  "cropAdd.lotPlaceholder": "e.g. {label} plot 1",
  "cropAdd.variety": "Variety",
  "cropAdd.area": "Planted area (ha)",
  "cropAdd.save": "Save crop",

  "pickup.worker": "Worker",
  "pickup.crop": "Crop",
  "pickup.noWorkers": "No workers yet — add one first.",
  "pickup.noCrops": "No crops yet — add one first.",
  "pickup.weight": "Weight ({unit})",
  "pickup.save": "Save pickup",
  "pickup.saved": "✅ Pickup saved",

  "reports.total": "Total {unit}",
  "reports.pickups": "Pickups",
  "reports.toPay": "To pay",
  "reports.pickers": "Workers",
  "reports.week": "Week",
  "reports.worker": "Worker",
  "reports.crop": "Crop",
  "reports.byWeek": "Harvest by week",
  "reports.byWorker": "Harvest by worker",
  "reports.byCrop": "Harvest by crop",
  "reports.unitsCollected": "{unit} collected",
  "reports.noPickups": "No pickups registered yet.",
  "reports.recent": "Recent pickups",
  "reports.nothing": "Nothing yet.",

  "settings.cropTypeTitle": "Crop type",
  "settings.cropTypeSub": "Pick one to load its default units",
  "settings.unitsTitle": "Units and cost",
  "settings.cropName": "Crop name",
  "settings.unit": "Unit of measure",
  "settings.unitPlaceholder": "kg, bunch, ton…",
  "settings.yieldUnit": "Yield unit",
  "settings.generalCost": "General cost per {unit}",
  "settings.generalCostHelp":
    "This cost applies to every week unless you override it below.",
  "settings.saveConfig": "Save configuration",
  "settings.weekCostsTitle": "Weekly costs",
  "settings.weekCostsSub": "Override the cost per unit for specific weeks",
  "settings.noWeeks": "No pickups registered yet to assign weekly costs.",
  "settings.week": "Week",
  "settings.costPer": "Cost per {unit}",
  "settings.add": "Add",
  "settings.demoTitle": "Demo data",
  "settings.demoSub": "Workers, crops and 4 weeks of pickups",
  "settings.loadDemo": "Load demo",
  "settings.clearAll": "Clear all",
  "settings.languageTitle": "Language",
  "settings.languageSub": "App language",
  "settings.saved": "✅ Configuration saved",
  "settings.demoLoaded": "✅ Demo data loaded",
  "settings.cleared": "🗑️ Data cleared",
  "settings.chooseWeekCost": "Pick a week and a valid cost",
  "settings.weekUpdated": "✅ Cost for {week} updated",

  "reports.lots": "Lots",

  "worker.performance": "Performance",
  "worker.avg": "Avg {unit}",
  "worker.days": "Active days",
  "worker.byWeek": "Performance by week",
  "worker.byCrop": "By crop",
  "worker.deletedBadge": "Inactive",

  "confirm.deleteWorkerTitle": "Delete worker?",
  "confirm.deleteWorkerBody":
    "They'll be hidden from the list, but their harvest history is kept.",
  "confirm.cancel": "Cancel",
  "confirm.delete": "Delete",

  "unit.default": "unit",
};

const pt: Dict = {
  "nav.home": "Início",
  "nav.workers": "Colhedores",
  "nav.crops": "Culturas",
  "nav.pickup": "Colheita",
  "nav.reports": "Relatórios",
  "nav.settings": "Ajustes",
  "stack.newWorker": "Novo colhedor",
  "stack.newCrop": "Nova cultura",
  "stack.registerPickup": "Registrar colheita",

  "home.totalHarvested": "Total colhido",
  "home.pickupsCount": "{n} colheitas",
  "home.today": "Hoje",
  "home.thisWeek": "Esta semana",
  "home.registerPickup": "Registrar colheita",
  "home.recentActivity": "Atividade recente",
  "home.noPickups": "Ainda não há colheitas. Toque em “Registrar colheita”.",

  "label.workers": "Colhedores",
  "label.crops": "Culturas",
  "label.pickups": "Colheitas",

  "people.empty": "Ainda não há colhedores. Toque em + para adicionar.",
  "people.tag": "cartão",

  "peopleAdd.gallery": "Galeria",
  "peopleAdd.camera": "Câmera",
  "peopleAdd.removePhoto": "Remover foto",
  "peopleAdd.firstName": "Nome *",
  "peopleAdd.lastName": "Sobrenome",
  "peopleAdd.docType": "Tipo de documento",
  "peopleAdd.docId": "Número do documento",
  "peopleAdd.rfid": "Cartão / etiqueta RFID",
  "peopleAdd.rfidHelp": "O cartão identifica o colhedor na balança.",
  "peopleAdd.save": "Salvar colhedor",

  "crops.empty": "Ainda não há culturas. Toque em + para adicionar.",

  "cropAdd.type": "Tipo de cultura *",
  "cropAdd.measuredIn": "Medido em {unit} · {yield}",
  "cropAdd.lotName": "Nome do lote *",
  "cropAdd.lotPlaceholder": "ex. {label} lote 1",
  "cropAdd.variety": "Variedade",
  "cropAdd.area": "Área plantada (ha)",
  "cropAdd.save": "Salvar cultura",

  "pickup.worker": "Colhedor",
  "pickup.crop": "Cultura",
  "pickup.noWorkers": "Nenhum colhedor — adicione um primeiro.",
  "pickup.noCrops": "Nenhuma cultura — adicione uma primeiro.",
  "pickup.weight": "Peso ({unit})",
  "pickup.save": "Salvar colheita",
  "pickup.saved": "✅ Colheita salva",

  "reports.total": "Total {unit}",
  "reports.pickups": "Colheitas",
  "reports.toPay": "A pagar",
  "reports.pickers": "Colhedores",
  "reports.week": "Semana",
  "reports.worker": "Colhedor",
  "reports.crop": "Cultura",
  "reports.byWeek": "Colheita por semana",
  "reports.byWorker": "Colheita por colhedor",
  "reports.byCrop": "Colheita por cultura",
  "reports.unitsCollected": "{unit} colhidos",
  "reports.noPickups": "Ainda não há colheitas registradas.",
  "reports.recent": "Colheitas recentes",
  "reports.nothing": "Nada ainda.",

  "settings.cropTypeTitle": "Tipo de cultura",
  "settings.cropTypeSub": "Escolha um para carregar suas unidades padrão",
  "settings.unitsTitle": "Unidades e custo",
  "settings.cropName": "Nome da cultura",
  "settings.unit": "Unidade de medida",
  "settings.unitPlaceholder": "kg, cacho, tonelada…",
  "settings.yieldUnit": "Unidade de rendimento",
  "settings.generalCost": "Custo geral por {unit}",
  "settings.generalCostHelp":
    "Este custo aplica-se a todas as semanas, salvo se você o substituir abaixo.",
  "settings.saveConfig": "Salvar configuração",
  "settings.weekCostsTitle": "Custos por semana",
  "settings.weekCostsSub": "Substitua o custo por unidade em semanas específicas",
  "settings.noWeeks": "Ainda não há colheitas registradas para atribuir custos por semana.",
  "settings.week": "Semana",
  "settings.costPer": "Custo por {unit}",
  "settings.add": "Adicionar",
  "settings.demoTitle": "Dados de demonstração",
  "settings.demoSub": "Colhedores, culturas e 4 semanas de colheitas",
  "settings.loadDemo": "Carregar demo",
  "settings.clearAll": "Apagar tudo",
  "settings.languageTitle": "Idioma",
  "settings.languageSub": "Idioma do aplicativo",
  "settings.saved": "✅ Configuração salva",
  "settings.demoLoaded": "✅ Dados de demo carregados",
  "settings.cleared": "🗑️ Dados apagados",
  "settings.chooseWeekCost": "Escolha uma semana e um custo válido",
  "settings.weekUpdated": "✅ Custo de {week} atualizado",

  "reports.lots": "Lotes",

  "worker.performance": "Desempenho",
  "worker.avg": "Méd. {unit}",
  "worker.days": "Dias ativos",
  "worker.byWeek": "Desempenho por semana",
  "worker.byCrop": "Por cultura",
  "worker.deletedBadge": "Inativo",

  "confirm.deleteWorkerTitle": "Excluir colhedor?",
  "confirm.deleteWorkerBody":
    "Ele será ocultado da lista, mas o histórico de colheita é mantido.",
  "confirm.cancel": "Cancelar",
  "confirm.delete": "Excluir",

  "unit.default": "unidade",
};

const DICTS: Record<Lang, Dict> = { es, en, pt };

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>) {
  let s = DICTS[lang][key] ?? DICTS.es[key] ?? key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
  }
  return s;
}

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: TFn }>({
  lang: "es",
  setLang: () => {},
  t: (k) => k,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => Prefs.getLang());
  const value = useMemo(
    () => ({
      lang,
      setLang: (l: Lang) => {
        Prefs.setLang(l);
        setLangState(l);
      },
      t: (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    }),
    [lang],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useT() {
  return useContext(LangContext);
}
