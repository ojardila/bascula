/**
 * An optional piece of a label: `before + value + after` when there is a
 * value, nothing otherwise. «Cantidad (Kilo)», «lote · Café», «+ 3 Bulto».
 *
 * The check is plain truthiness, exactly like the inline
 * `${value ? ` · ${value}` : ""}` it replaces.
 */
export function affix(
  value: string | number | null | undefined,
  before: string,
  after = "",
): string {
  return value ? `${before}${value}${after}` : "";
}
