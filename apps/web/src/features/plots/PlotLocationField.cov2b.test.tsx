// SPDX-License-Identifier: MIT
/**
 * The location field while it waits for the satellites, with a fair signal,
 * and when the phone fails for a reason that is neither a refusal nor a
 * timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PlotLocationField } from "./PlotLocationField";

type GeoSuccess = (p: GeolocationPosition) => void;
type GeoFailure = (e: GeolocationPositionError) => void;

let pending: { ok: GeoSuccess; fail: GeoFailure } | null = null;

function stubPendingGeolocation() {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (ok: GeoSuccess, fail: GeoFailure) => {
        pending = { ok, fail };
      },
    },
  });
}

afterEach(() => {
  pending = null;
  Reflect.deleteProperty(navigator, "geolocation");
});

describe("taking the point", () => {
  it("explains the wait, then reports a fair signal in metres", () => {
    stubPendingGeolocation();
    const onChange = vi.fn();
    render(<PlotLocationField value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Estoy parado en el lote" }));
    expect(screen.getByRole("button", { name: "Buscando la señal…" })).toBeDisabled();
    expect(screen.getByText(/Puede tardar hasta medio minuto/)).toBeInTheDocument();
    act(() =>
      pending!.ok({
        coords: { latitude: 5.1, longitude: -75.2, accuracy: 42.4 } as GeolocationCoordinates,
        timestamp: Date.now(),
      } as GeolocationPosition),
    );
    expect(
      screen.getByText(
        "La señal alcanza para ubicar el lote, con un margen de unos 42 metros.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Puede tardar/)).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith({ type: "Point", coordinates: [-75.2, 5.1] });
  });

  it("says to try later when the position is simply unavailable", () => {
    stubPendingGeolocation();
    render(<PlotLocationField value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Estoy parado en el lote" }));
    act(() =>
      pending!.fail({
        code: 2,
        message: "unavailable",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError),
    );
    expect(
      screen.getByText(/No se pudo tomar la ubicación en este momento/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Estoy parado en el lote" })).toBeEnabled();
  });
});
