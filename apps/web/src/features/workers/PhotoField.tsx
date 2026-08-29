/**
 * The employee photo (RSP-004, up to 5 MB).
 *
 * Reads the file, downscales it in a canvas to a 512 px square and hands back
 * a JPEG data URL. Three reasons, in order of how much they matter:
 *
 *  1. A phone photo is 4 MB and the field limit is 5 MB. Downscaling before it
 *     ever leaves the browser means the limit is never the user's problem.
 *  2. The picture is shown at 96 px; sending 4000 px of it is bandwidth spent
 *     on a farm with one bar of signal.
 *  3. It crops to a square here, so the avatar is never a stretched face.
 *
 * When media uploads land (`POST /v1/media/uploads` -> presigned URL), this is
 * the component that changes: it will upload the resized blob and hand back a
 * mediaId instead of a data URL. Nothing else has to move.
 */
import { useRef, useState } from "react";
import { Avatar, Box, Button, Stack, Typography } from "@mui/material";
import PhotoCameraIcon from "@mui/icons-material/PhotoCamera";

const MAX_BYTES = 5 * 1024 * 1024;
const SIDE = 512;

async function toSquareDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo procesar la imagen.");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIDE, SIDE);
  return canvas.toDataURL("image/jpeg", 0.82);
}

interface Props {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  fallback: string;
}

export function PhotoField({ value, onChange, fallback }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("La foto pesa más de 5 MB. Tome una más liviana o use otra.");
      return;
    }
    try {
      onChange(await toSquareDataUrl(file));
    } catch {
      setError("No se pudo leer esa imagen. Pruebe con un JPG o un PNG.");
    }
  }

  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Avatar src={value ?? undefined} sx={{ width: 84, height: 84, fontSize: 30 }}>
        {fallback}
      </Avatar>
      <Box>
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<PhotoCameraIcon />}
            onClick={() => input.current?.click()}
          >
            {value ? "Cambiar foto" : "Agregar foto"}
          </Button>
          {value && (
            <Button size="small" color="inherit" onClick={() => onChange(null)}>
              Quitar
            </Button>
          )}
        </Stack>
        <Typography variant="caption" color={error ? "error" : "text.secondary"} component="div" sx={{ mt: 0.5 }}>
          {error ?? "Opcional. Hasta 5 MB; se recorta cuadrada."}
        </Typography>
      </Box>
    </Stack>
  );
}
