import { useState } from "react";
import { Autocomplete, TextField, createFilterOptions } from "@mui/material";
import type { CatalogItem } from "../api/types";

/**
 * "Elija uno, o escriba uno nuevo" — the picker RSP-011, RSP-019 and RSP-027
 * all ask for, in one component.
 *
 * The catalogues behave the same way on the server everywhere: `POST` is
 * idempotent by `lower(name)`, so typing "café" when "Café" exists returns the
 * existing row rather than a second one. That guarantee is what lets this
 * component be careless: it hands the typed text back and lets the caller
 * create it, without having to check first.
 *
 * The value is EITHER a catalogue item OR a bare name, which is the honest
 * shape of a picker that can invent entries: until it is saved, a name typed
 * in has no id, and pretending otherwise means either a fake id leaking into a
 * request body or a round trip on every keystroke.
 *
 * (`PlotFormPage` has its own copy of this from Sprint 1, made before there
 * were four more forms that needed it. It should move over; the reason it has
 * not yet is that it is the only one of the five with no test of its own.)
 */
export interface CatalogValue {
  id: string | null;
  name: string;
}

const filter = createFilterOptions<CatalogItem>();

export interface CatalogPickerProps {
  label: string;
  options: CatalogItem[];
  value: CatalogValue | null;
  onChange: (v: CatalogValue | null) => void;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  /** "categoría", "bodega" — used in the "Agregar «x»" line. */
  addWhat?: string;
  size?: "small" | "medium";
}

export function CatalogPicker({
  label, options, value, onChange, required, disabled, error, helperText,
  addWhat, size = "medium",
}: CatalogPickerProps) {
  const [input, setInput] = useState("");

  return (
    <Autocomplete
      options={options}
      disabled={disabled}
      value={value ? ({ id: value.id ?? "__new__", name: value.name } as CatalogItem) : null}
      inputValue={input || value?.name || ""}
      onInputChange={(_, v, reason) => {
        if (reason !== "reset") setInput(v);
      }}
      getOptionLabel={(o) => o.name}
      isOptionEqualToValue={(a, b) => a.id === b.id || a.name === b.name}
      filterOptions={(opts, state) => {
        const filtered = filter(opts, state);
        const typed = state.inputValue.trim();
        if (!typed) return filtered;
        const exists = opts.some(
          (o) => o.name.toLocaleLowerCase("es") === typed.toLocaleLowerCase("es"),
        );
        return exists ? filtered : [...filtered, { id: "__new__", name: typed }];
      }}
      renderOption={(props, option) => (
        <li {...props} key={`${option.id}-${option.name}`}>
          {option.id === "__new__"
            ? `Agregar ${addWhat ? `${addWhat} ` : ""}«${option.name}»`
            : option.name}
        </li>
      )}
      onChange={(_, v) => {
        setInput("");
        if (!v) return onChange(null);
        onChange({ id: v.id === "__new__" ? null : v.id, name: v.name });
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          size={size}
          required={required}
          error={!!error}
          helperText={error ?? helperText}
        />
      )}
    />
  );
}
