import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/node";
import { RegisterDebtDialog } from "./RegisterDebtDialog";
import { renderWithAuth, signInOwner } from "../../test/renderWithAuth";
import { FARM_ID, tenants } from "../../mocks/db";

beforeEach(() => signInOwner());

function firstWorkerId(): string {
  const worker = tenants.get(FARM_ID)?.workers[0];
  if (!worker) throw new Error("the seed has no workers");
  return worker.id;
}

function open() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  renderWithAuth(
    <RegisterDebtDialog
      open
      workerId={firstWorkerId()}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

describe("RegisterDebtDialog", () => {
  it("asks for a concept and an amount", async () => {
    const user = userEvent.setup();
    const { onSaved } = open();
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Registrar deuda" }),
    );
    expect(
      await within(dialog).findByText("Escriba de qué es la deuda."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Escriba un valor/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Valor/), "0");
    await user.click(
      within(dialog).getByRole("button", { name: "Registrar deuda" }),
    );
    expect(
      await within(dialog).findByText(/tiene que ser mayor que cero/),
    ).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("records the debt and says what will be deducted", async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = open();
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Concepto/), "Botas");
    await user.type(within(dialog).getByLabelText(/Valor/), "45000");
    expect(within(dialog).getByText(/Se descontará/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Registrar deuda" }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/v1/deductions", () =>
        HttpResponse.json(
          { error: { code: "FORBIDDEN", message: "no", details: {} } },
          { status: 403 },
        ),
      ),
    );
    const { onSaved } = open();
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Concepto/), "Machete");
    await user.type(within(dialog).getByLabelText(/Valor/), "20000");
    await user.click(
      within(dialog).getByRole("button", { name: "Registrar deuda" }),
    );
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
