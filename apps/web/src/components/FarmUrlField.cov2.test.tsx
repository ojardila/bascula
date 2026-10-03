// SPDX-License-Identifier: MIT
/**
 * The farm-address field: the name stops driving the address once the owner
 * edits it, a reserved address is named as such, an answer that arrives after
 * the address moved on is ignored, and the create-call refusals read as
 * sentences.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { server } from "../mocks/node";
import { ApiError } from "../api/errors";
import { FarmUrlField, slugErrorFromApi, useFarmUrl, useSlugCheck } from "./FarmUrlField";

function Harness() {
  const url = useFarmUrl();
  const check = useSlugCheck(url.slug);
  return (
    <>
      <label>
        Nombre de la finca
        <input onChange={(e) => url.followName(e.target.value)} />
      </label>
      <FarmUrlField slug={url.slug} onChange={url.setSlug} check={check} />
      <output data-testid="check">{check}</output>
    </>
  );
}

const address = () => screen.getByLabelText(/Dirección web de la finca/);

describe("useFarmUrl", () => {
  it("follows the name until the address is edited, and empties for a blank name", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/farm-slugs", () => HttpResponse.json({ available: true })));
    render(<Harness />);
    const name = screen.getByLabelText("Nombre de la finca");
    await user.type(name, "La Palma");
    expect(address()).toHaveValue("la-palma");
    await user.clear(name);
    await user.type(name, " ");
    expect(address()).toHaveValue("");

    await user.type(address(), "miranda");
    await user.type(name, "Otra");
    expect(address()).toHaveValue("miranda");
  });
});

describe("useSlugCheck", () => {
  it("names a reserved address in Spanish", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/farm-slugs", () => HttpResponse.json({ available: false, reason: "reserved" })),
    );
    render(<Harness />);
    await user.type(address(), "cafetal");
    expect(
      await screen.findByText("Esa dirección está reservada. Escriba otra."),
    ).toBeInTheDocument();
  });

  it("says nothing when the check cannot reach the server", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/v1/farm-slugs", () => HttpResponse.error()));
    render(<Harness />);
    await user.type(address(), "cafetal");
    await waitFor(() => expect(screen.getByTestId("check")).toHaveTextContent("unknown"), {
      timeout: 3000,
    });
    expect(screen.queryByText("Disponible")).not.toBeInTheDocument();
    expect(screen.queryByText("Revisando…")).not.toBeInTheDocument();
  });

  it("ignores answers and failures that arrive after the address changed", async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get("*/v1/farm-slugs", async ({ request }) => {
        calls += 1;
        const slug = new URL(request.url).searchParams.get("slug");
        await delay(300);
        if (slug === "uno") return HttpResponse.json({ available: false, reason: "taken" });
        if (slug === "unod") return HttpResponse.error();
        return HttpResponse.json({ available: true });
      }),
    );
    render(<Harness />);
    await user.type(address(), "uno");
    // The request for "uno" is in flight; the owner keeps typing.
    await waitFor(() => expect(calls).toBe(1), { timeout: 2000 });
    await user.type(address(), "d");
    await waitFor(() => expect(calls).toBe(2), { timeout: 2000 });
    await user.type(address(), "os");
    expect(await screen.findByText("Disponible", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(/ya la tiene otra finca/)).not.toBeInTheDocument();
    expect(screen.getByTestId("check")).toHaveTextContent("free");
  });
});

describe("slugErrorFromApi", () => {
  it("is null for anything that is not an API error", () => {
    expect(slugErrorFromApi(new Error("slug"))).toBeNull();
  });

  it("names a reserved address and explains the format otherwise", () => {
    const err = (message: string) => new ApiError(400, { error: { code: "INVALID", message } });
    expect(slugErrorFromApi(err("slug is reserved"))).toBe(
      "Esa dirección está reservada. Escriba otra.",
    );
    expect(slugErrorFromApi(err("slug must be lowercase"))).toBe(
      "Use solo letras minúsculas sin tildes, números y guiones. Ejemplo: lapalma",
    );
  });
});
