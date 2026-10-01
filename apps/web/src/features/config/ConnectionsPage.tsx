import { Box, Stack, Typography } from "@mui/material";
import { ConnectionsCard } from "./ConnectionsCard";
import { McpActivityCard } from "./McpActivityCard";
import { ChangePasswordCard } from "./ChangePasswordCard";

/**
 * «Conexiones» as a page of its own, for the weigher: they have no
 * Configuración, yet they can connect an assistant with their account, so they
 * need a place to see it and revoke it. The owner and the administrator see
 * the same card inside Configuración. «Cambiar clave» is here for the same
 * reason.
 */
export function ConnectionsPage() {
  return (
    <Box>
      <Typography variant="h1" gutterBottom>
        Conexiones
      </Typography>
      <Stack spacing={3}>
        <ConnectionsCard />
        <McpActivityCard />
        <ChangePasswordCard />
      </Stack>
    </Box>
  );
}
