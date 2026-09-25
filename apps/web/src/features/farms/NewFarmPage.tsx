/**
 * "Crear otra finca" — for an owner who is already inside the app.
 *
 * Two fields and one button: the name and the web address. It posts
 * /v1/farms with the caller's session (the account is the proof of ownership),
 * and then shows the same waiting screen the landing shows while the farm's
 * own space is prepared.
 */
import { useState, type FormEvent } from "react";
import { Alert, Box, Button, Container, Stack, TextField, Typography } from "@mui/material";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { farmSlugProblem } from "../../lib/farmHost";
import { useWriteOnce } from "../../lib/writeOnce";
import {
  FarmUrlField, slugErrorFromApi, useFarmUrl, useSlugCheck,
} from "../../components/FarmUrlField";
import { ProvisionProgress } from "../provision/ProvisionProgress";

/** The same starting price signup uses; it is changed later in Configuración. */
const DEFAULT_PRICE_CENTS = 80000;

export function NewFarmPage() {
  const { busy, run } = useWriteOnce();
  const [name, setName] = useState("");
  const url = useFarmUrl();
  const check = useSlugCheck(url.slug);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNameError(name.trim() ? null : "Escriba el nombre de la finca.");
    const problem =
      farmSlugProblem(url.slug) ??
      (check === "taken" ? "Esa dirección ya la tiene otra finca. Escriba otra." : null);
    setSlugError(problem);
    if (!name.trim() || problem) return;
    const outcome = await run(`new-farm|${url.slug}`, (mint) =>
      api.createFarm({ id: mint(), name: name.trim(), slug: url.slug, priceCents: DEFAULT_PRICE_CENTS }),
    ).catch((err: unknown) => {
      const slugMsg = slugErrorFromApi(err);
      if (slugMsg) setSlugError(slugMsg);
      else setError(messageFor(err));
      return { ran: false } as const;
    });
    if (outcome.ran && outcome.value) setCreated(outcome.value.slug);
  }

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 2, sm: 4 } }}>
      {created ? (
        <ProvisionProgress slug={created} />
      ) : (
        <Box component="form" onSubmit={onSubmit} noValidate>
          <Stack spacing={3}>
            <Typography component="h1" sx={{ fontSize: { xs: "1.8rem", sm: "2.2rem" }, fontWeight: 700 }}>
              Crear otra finca
            </Typography>
            <Typography sx={{ fontSize: "1.1rem" }} color="text.secondary">
              La nueva finca tiene su propia dirección en internet y sus propios datos.
              Usted entra con el mismo correo y la misma clave.
            </Typography>
            {error && <Alert severity="error" sx={{ fontSize: "1.05rem" }}>{error}</Alert>}
            <TextField
              label="Nombre de la finca"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                url.followName(e.target.value);
                setSlugError(null);
              }}
              error={!!nameError}
              helperText={nameError ?? "Ejemplo: La Palma"}
              fullWidth
              autoFocus
              required
              sx={{ "& .MuiInputBase-input": { fontSize: "1.2rem" } }}
            />
            <FarmUrlField
              slug={url.slug}
              onChange={(v) => {
                url.setSlug(v);
                setSlugError(null);
              }}
              check={check}
              serverError={slugError}
              disabled={busy}
            />
            <Button
              type="submit"
              variant="contained"
              size="large"
              disabled={busy}
              fullWidth
              sx={{ minHeight: 64, fontSize: "1.25rem", borderRadius: 999 }}
            >
              {busy ? "Creando la finca…" : "Crear finca"}
            </Button>
          </Stack>
        </Box>
      )}
    </Container>
  );
}
