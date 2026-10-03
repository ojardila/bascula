// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhotoField } from "./PhotoField";

const file = (bytes: number, name = "foto.jpg") =>
  new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });

function fileInputs(container: HTMLElement) {
  return [
    ...container.querySelectorAll('input[type="file"]'),
  ] as HTMLInputElement[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PhotoField", () => {
  it("crops a picked photo to a square JPEG", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 800, height: 600 })),
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,AAA",
    );
    const onChange = vi.fn();
    const { container } = render(
      <PhotoField value={null} onChange={onChange} fallback="MR" />,
    );
    expect(
      screen.getByRole("button", { name: /Elegir foto/ }),
    ).toBeInTheDocument();
    fireEvent.change(fileInputs(container)[0], {
      target: { files: [file(1000)] },
    });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("data:image/jpeg;base64,AAA"),
    );
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      100,
      0,
      600,
      600,
      0,
      0,
      512,
      512,
    );
  });

  it("refuses a photo over 5 MB", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PhotoField value={null} onChange={onChange} fallback="MR" />,
    );
    fireEvent.change(screen.getByTestId("photo-camera-input"), {
      target: { files: [file(5 * 1024 * 1024 + 1)] },
    });
    expect(screen.getByText(/La foto pesa más de 5 MB/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(fileInputs(container)[0], { target: { files: [] } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says when the image cannot be read", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 10, height: 10 })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onChange = vi.fn();
    const { container } = render(
      <PhotoField value={null} onChange={onChange} fallback="MR" />,
    );
    fireEvent.change(fileInputs(container)[0], {
      target: { files: [file(10)] },
    });
    expect(
      await screen.findByText(/No se pudo leer esa imagen/),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the pickers and removes a photo", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <PhotoField
        value="data:image/jpeg;base64,AAA"
        onChange={onChange}
        fallback="MR"
      />,
    );
    const [library, camera] = fileInputs(container);
    const libClick = vi.spyOn(library, "click");
    const camClick = vi.spyOn(camera, "click");
    await user.click(screen.getByRole("button", { name: /Tomar foto/ }));
    expect(camClick).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Cambiar foto/ }));
    expect(libClick).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Quitar" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
