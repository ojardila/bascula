/**
 * The field that replaced 1,822 lines of polygon drawing.
 *
 * The drawing surface had no basemap on purpose -- no tile source is
 * same-origin and none of them work on a farm with no signal -- so tracing a
 * lot meant tracing over a grey rectangle, from memory, with a finger. What it
 * produced was `computedAreaHa`, whose only consumer displayed it next to the
 * hectares the same person had already typed. Across every real farm in the
 * database, 2 plots out of 138 have a boundary.
 *
 * What is asserted here is not that the component renders. It is the two
 * properties the replacement exists for: a point can be taken back, and every
 * failure says what to do next rather than naming an error code. The intended
 * user "barely uses a smartphone", so a message they cannot act on is the same
 * as no message.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PlotLocationField, pointOf, openInMaps, formatPoint } from "./PlotLocationField";

type GeoSuccess = (p: GeolocationPosition) => void;
type GeoFailure = (e: GeolocationPositionError) => void;

function stubGeolocation(impl: (ok: GeoSuccess, fail: GeoFailure) => void) {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: (ok: GeoSuccess, fail: GeoFailure) => impl(ok, fail) },
  });
}

function positionAt(lat: number, lon: number, accuracy: number): GeolocationPosition {
  return {
    coords: { latitude: lat, longitude: lon, accuracy } as GeolocationCoordinates,
    timestamp: Date.now(),
  } as GeolocationPosition;
}

describe("reading a point off the wire", () => {
  it("takes a Point and nothing else", () => {
    expect(pointOf({ type: "Point", coordinates: [-75.88, 5.66] })).toEqual({
      type: "Point",
      coordinates: [-75.88, 5.66],
    });
    // A boundary is a different field. If a polygon ever arrives here it is a
    // bug elsewhere, and rendering it as a location would hide that.
    expect(pointOf({ type: "Polygon", coordinates: [[[0, 0]]] })).toBeNull();
    expect(pointOf(null)).toBeNull();
    expect(pointOf({ type: "Point", coordinates: ["x", "y"] })).toBeNull();
  });

  it("reads back latitude first, which is the order a person says out loud", () => {
    // The wire is longitude first, as GeoJSON requires. What a person reads to
    // somebody over the phone is not.
    expect(formatPoint({ type: "Point", coordinates: [-75.88, 5.66] })).toBe("5.66000, -75.88000");
  });

  it("builds a maps link that the phone's own app will take", () => {
    const url = openInMaps({ type: "Point", coordinates: [-75.88, 5.66] });
    expect(url).toContain("5.66,-75.88");
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("capturing where the plot is", () => {
  const realGeo = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  afterEach(() => {
    if (realGeo) Object.defineProperty(navigator, "geolocation", realGeo);
    vi.restoreAllMocks();
  });
  beforeEach(() => vi.restoreAllMocks());

  it("hands up a point when the owner is standing in the plot", async () => {
    stubGeolocation((ok) => ok(positionAt(5.66, -75.88, 8)));
    const onChange = vi.fn();
    render(<PlotLocationField value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Estoy parado en el lote/i }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ type: "Point", coordinates: [-75.88, 5.66] }),
    );
  });

  it("can be taken back, because a point gets captured at the wrong gate", async () => {
    const onChange = vi.fn();
    render(
      <PlotLocationField
        value={{ type: "Point", coordinates: [-75.88, 5.66] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Quitar/i }));
    // null, not undefined: the form sends null to erase, and sends nothing at
    // all when the field was never touched. If this handed up undefined, the
    // erase would silently become "leave it alone".
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("says the signal is weak rather than saving a confident wrong point", async () => {
    stubGeolocation((ok) => ok(positionAt(5.66, -75.88, 400)));
    render(<PlotLocationField value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Estoy parado en el lote/i }));
    await waitFor(() => expect(screen.getByText(/señal está débil/i)).toBeTruthy());
    expect(screen.getByText(/400 metros/)).toBeTruthy();
  });

  it("a refusal says what to do next, not which error it was", async () => {
    stubGeolocation((_ok, fail) =>
      fail({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
    );
    render(<PlotLocationField value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Estoy parado en el lote/i }));
    // The instruction, not the word PERMISSION_DENIED.
    await waitFor(() => expect(screen.getByText(/candado junto a la dirección/i)).toBeTruthy());
  });

  it("a timeout tells somebody under trees to walk out, which is the fix", async () => {
    stubGeolocation((_ok, fail) =>
      fail({ code: 3, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError),
    );
    render(<PlotLocationField value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Estoy parado en el lote/i }));
    await waitFor(() => expect(screen.getByText(/salga a campo abierto/i)).toBeTruthy());
  });

  it("a device that cannot locate at all does not block saving the plot", async () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    render(<PlotLocationField value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Estoy parado en el lote/i }));
    await waitFor(() => expect(screen.getByText(/puede guardar el lote sin la ubicación/i)).toBeTruthy());
  });
});
