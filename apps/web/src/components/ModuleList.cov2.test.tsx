// SPDX-License-Identifier: MIT
/**
 * A confirm pressed on a dialog that is already closing (cancelled a moment
 * before, still fading out) must not take the row out of service.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModuleList } from "./ModuleList";

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [{ id: "a", name: "Lote Alto" }];

describe("ModuleList confirm dialog", () => {
  it("ignores a confirm that lands after the dialog was cancelled", async () => {
    const user = userEvent.setup();
    const onDeactivate = vi.fn(async () => {});
    render(
      <ModuleList<Row>
        title="Lotes"
        singular="lote"
        plural="lotes"
        rows={ROWS}
        columns={[{ key: "name", header: "Nombre", render: (r) => r.name }]}
        getId={(r) => r.id}
        getName={(r) => r.name}
        isInactive={() => false}
        search=""
        onSearchChange={() => {}}
        searchPlaceholder="Buscar lote"
        statusFilter="all"
        onStatusFilterChange={() => {}}
        onDeactivate={onDeactivate}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Acciones de Lote Alto" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dar de baja" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Dar de baja" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onDeactivate).not.toHaveBeenCalled();
  });
});
