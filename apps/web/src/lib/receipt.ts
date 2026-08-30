/**
 * EL NÚMERO QUE EL DUEÑO LEERÍA EN VOZ ALTA SI ALGUIEN RECLAMA.
 *
 * La API no emite números de recibo, así que la consola imprimía el id del
 * movimiento — un UUID de 36 caracteres — encabezando el recibo de pago. Es
 * exactamente el dato que se va a usar cuando haya un reclamo: alguien llama,
 * lee el recibo por teléfono y del otro lado lo apuntan. Nadie dicta
 * «0192f3a0-0009-7000-8000-000000000003» sin equivocarse, y quien lo intenta
 * concluye, con razón, que el papel no es para él.
 *
 * Así que el recibo se encabeza con los ocho últimos dígitos del id, en dos
 * bloques de cuatro y en mayúsculas: `3F7A-91C2`. Se dicta de una vez, se
 * apunta a mano, y se busca — el id completo va igual en el pie del papel, en
 * letra pequeña, porque es lo que un soporte necesita y no es lo que el dueño
 * lee.
 *
 * NO ES UN CONSECUTIVO y no se pretende que lo sea. Un consecutivo por finca
 * es una columna del servidor y una decisión suya; inventarlo aquí daría dos
 * recibos «N.º 14» en cuanto dos dispositivos escriban a la vez. Esto es el
 * mismo identificador, escrito para una persona. El día que la API emita
 * consecutivos, esta función se borra y `receiptNumber` viene del servidor.
 *
 * Los UUIDv7 comparten prefijo (van ordenados por tiempo) y no cola: los
 * últimos dígitos son la parte aleatoria, que es justo la que distingue dos
 * pagos de la misma tarde.
 */

/** `0192f3a0-…-8000-00000000ab3f` -> `0000-AB3F`. */
export function shortReceiptNumber(id: string): string {
  const hex = id.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length < 8) return id.toUpperCase();
  const tail = hex.slice(-8).toUpperCase();
  return `${tail.slice(0, 4)}-${tail.slice(4)}`;
}
