import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ModuleList,
  type ModuleListProps,
  type StatusFilter,
} from "./ModuleList";

interface Row {
  id: string;
  name: string;
  off: boolean;
}

const ROWS: Row[] = [
  { id: "a", name: "Lote Alto", off: false },
  { id: "b", name: "Lote Bajo", off: true },
];

function Harness(over: Partial<ModuleListProps<Row>>) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  return (
    <ModuleList<Row>
      title="Lotes"
      singular="lote"
      plural="lotes"
      rows={ROWS}
      columns={[{ key: "name", header: "Nombre", render: (r) => r.name }]}
      getId={(r) => r.id}
      getName={(r) => r.name}
      isInactive={(r) => r.off}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Buscar lote"
      statusFilter={status}
      onStatusFilterChange={setStatus}
      {...over}
    />
  );
}

describe("ModuleList", () => {
  it("opens every row action from the menu", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onEdit = vi.fn();
    const extra = vi.fn();
    render(
      <Harness
        onRowClick={onRowClick}
        onEdit={onEdit}
        extraActions={() => [{ label: "Imprimir", onClick: extra }]}
        onDeactivate={vi.fn()}
        onReactivate={vi.fn()}
      />,
    );
    const open = () =>
      user.click(screen.getByRole("button", { name: "Acciones de Lote Alto" }));
    await open();
    await user.click(
      await screen.findByRole("menuitem", { name: "Ver detalle" }),
    );
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
    await open();
    await user.click(await screen.findByRole("menuitem", { name: "Editar" }));
    expect(onEdit).toHaveBeenCalledWith(ROWS[0]);
    await open();
    await user.click(await screen.findByRole("menuitem", { name: "Imprimir" }));
    expect(extra).toHaveBeenCalled();
    await open();
    expect(
      screen.queryByRole("menuitem", { name: "Reactivar" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("asks before taking a row out of service, and can be cancelled", async () => {
    const user = userEvent.setup();
    const onDeactivate = vi.fn(async () => {});
    render(<Harness onDeactivate={onDeactivate} />);
    await user.click(
      screen.getByRole("button", { name: "Acciones de Lote Alto" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Dar de baja" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("¿Dar de baja «Lote Alto»?"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/queda inactiva/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Cancelar/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(onDeactivate).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Acciones de Lote Alto" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Dar de baja" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Dar de baja",
      }),
    );
    await waitFor(() => expect(onDeactivate).toHaveBeenCalledWith(ROWS[0]));
  });

  it("reactivates an inactive row", async () => {
    const user = userEvent.setup();
    const onReactivate = vi.fn();
    render(<Harness onReactivate={onReactivate} onDeactivate={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: "Acciones de Lote Bajo" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: "Dar de baja" }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("menuitem", { name: "Reactivar" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/vuelve a estar disponible/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reactivar" }));
    await waitFor(() => expect(onReactivate).toHaveBeenCalledWith(ROWS[1]));
  });

  it("searches and filters by status", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    const onStatusFilterChange = vi.fn();
    render(
      <Harness
        onSearchChange={onSearchChange}
        onStatusFilterChange={onStatusFilterChange}
      />,
    );
    await user.type(screen.getByLabelText("Buscar lote"), "A");
    expect(onSearchChange).toHaveBeenCalledWith("A");
    await user.click(screen.getByRole("button", { name: "Inactivas" }));
    expect(onStatusFilterChange).toHaveBeenCalledWith("inactive");
  });

  it("says when a search finds nothing, or there is nothing yet, and offers to create", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { rerender } = render(
      <Harness rows={[]} search="zzz" onCreate={onCreate} />,
    );
    expect(
      screen.getByText("Ningún resultado para esa búsqueda"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pruebe con otro nombre/)).toBeInTheDocument();
    rerender(<Harness rows={[]} onCreate={onCreate} />);
    expect(screen.getByText("Todavía no hay lotes")).toBeInTheDocument();
    expect(screen.getByText(/Use el botón de arriba/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /Nueva lote/ });
    await user.click(buttons[buttons.length - 1]);
    expect(onCreate).toHaveBeenCalled();
    rerender(
      <Harness
        rows={[]}
        emptyTitle="Sin lotes"
        emptyBody="Cree uno."
        onCreate={onCreate}
        createLabel="Crear lote"
      />,
    );
    expect(screen.getByText("Sin lotes")).toBeInTheDocument();
    expect(screen.getByText("Cree uno.")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /Crear lote/ }).length,
    ).toBeGreaterThan(0);
  });
});
