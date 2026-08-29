/**
 * The authenticated frame: fixed sidebar, farm in the top bar, content in a
 * card. The layout of cropti/farmlogs that the owner pointed at.
 *
 * Modules the role cannot use are not rendered. Modules of later sprints are
 * rendered and disabled, so the map the owner drew stays visible instead of
 * the sidebar growing an entry every three weeks.
 */
import { useState, type ReactNode } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import {
  AppBar, Avatar, Box, Chip, Divider, Drawer, IconButton, List, ListItemButton,
  ListItemIcon, ListItemText, Menu, MenuItem, Stack, Toolbar, Tooltip, Typography,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import TerrainIcon from "@mui/icons-material/Terrain";
import PeopleIcon from "@mui/icons-material/Groups";
import AgricultureIcon from "@mui/icons-material/Agriculture";
import TaskIcon from "@mui/icons-material/FactCheck";
import ReceiptIcon from "@mui/icons-material/ReceiptLong";
import SellIcon from "@mui/icons-material/Sell";
import PaymentsIcon from "@mui/icons-material/Payments";
import InventoryIcon from "@mui/icons-material/Inventory2";
import SettingsIcon from "@mui/icons-material/Settings";
import LockIcon from "@mui/icons-material/Lock";
import { useAuth } from "../auth/AuthContext";
import { MODULES, can } from "../auth/permissions";
import { SyncWarningBanner } from "./SyncWarningBanner";
import { ApiModeBanner } from "./ApiModeBanner";
import { GREEN_DARK } from "../theme";

const WIDTH = 232;

const ICONS: Record<string, ReactNode> = {
  dashboard: <DashboardIcon />,
  terrain: <TerrainIcon />,
  people: <PeopleIcon />,
  agriculture: <AgricultureIcon />,
  task: <TaskIcon />,
  receipt: <ReceiptIcon />,
  sell: <SellIcon />,
  payments: <PaymentsIcon />,
  inventory: <InventoryIcon />,
  settings: <SettingsIcon />,
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  administrator: "Administrador",
  weigher: "Pesador",
};

export function AppShell({ children }: { children: ReactNode }) {
  const { user, principal, logout, readOnly } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);

  const nav = (
    <Box sx={{ py: 1 }}>
      <List dense>
        {MODULES.map((m) => {
          const allowed = can(principal, m.action);
          if (!allowed) return null; // Hidden, not disabled: it is not theirs.
          const future = !m.available;
          const selected = location.pathname.startsWith(m.path);
          const item = (
            <ListItemButton
              key={m.key}
              component={future ? "div" : RouterLink}
              to={future ? undefined : m.path}
              selected={selected}
              disabled={future}
              onClick={() => setMobileOpen(false)}
              sx={{
                mx: 1, borderRadius: 2, mb: 0.25,
                "&.Mui-selected": { bgcolor: "#e6f0e4", color: GREEN_DARK },
                "&.Mui-selected .MuiListItemIcon-root": { color: GREEN_DARK },
              }}
            >
              <ListItemIcon sx={{ minWidth: 38 }}>
                {future ? <LockIcon fontSize="small" /> : ICONS[m.icon]}
              </ListItemIcon>
              <ListItemText
                primary={m.label}
                slotProps={{ primary: { fontWeight: selected ? 700 : 500, fontSize: 14 } }}
              />
              {future && (
                <Chip size="small" label={`S${m.sprint}`} sx={{ height: 18, fontSize: 10 }} />
              )}
            </ListItemButton>
          );
          return future ? (
            <Tooltip
              key={m.key}
              title={`Este módulo llega en el sprint ${m.sprint}.`}
              placement="right"
            >
              <span>{item}</span>
            </Tooltip>
          ) : (
            item
          );
        })}
      </List>
    </Box>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100dvh", bgcolor: "background.default" }}>
      <AppBar
        position="fixed"
        color="inherit"
        elevation={0}
        sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: 1, borderColor: "divider" }}
      >
        <Toolbar sx={{ gap: 2 }}>
          <IconButton
            edge="start"
            onClick={() => setMobileOpen((v) => !v)}
            sx={{ display: { md: "none" } }}
            aria-label="Abrir menú"
          >
            <MenuIcon />
          </IconButton>

          <Typography
            component={RouterLink}
            to="/"
            sx={{
              fontWeight: 800, letterSpacing: "-0.02em", color: GREEN_DARK,
              textDecoration: "none", fontSize: 20,
            }}
          >
            BÁSCULA
          </Typography>

          <Divider orientation="vertical" flexItem sx={{ my: 1.5 }} />

          <Typography sx={{ fontWeight: 600 }}>{user?.farm?.name}</Typography>

          {user?.farm?.status === "trial" && (
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label={`Prueba · ${user.farm.trialDaysLeft} días`}
            />
          )}
          {readOnly && (
            <Chip size="small" color="error" label="Suspendida · solo lectura" />
          )}

          <Box sx={{ flex: 1 }} />

          <Stack direction="row" alignItems="center" spacing={1}>
            <Chip size="small" variant="outlined" label={ROLE_LABEL[principal.role]} />
            <IconButton onClick={(e) => setUserMenu(e.currentTarget)} aria-label="Cuenta">
              <Avatar sx={{ width: 32, height: 32, bgcolor: GREEN_DARK, fontSize: 14 }}>
                {user?.name?.[0] ?? "?"}
              </Avatar>
            </IconButton>
          </Stack>

          <Menu anchorEl={userMenu} open={!!userMenu} onClose={() => setUserMenu(null)}>
            <MenuItem disabled>{user?.email}</MenuItem>
            <Divider />
            <MenuItem
              onClick={async () => {
                setUserMenu(null);
                await logout();
                navigate("/entrar");
              }}
            >
              Cerrar sesión
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box component="nav" sx={{ width: { md: WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: "block", md: "none" },
            "& .MuiDrawer-paper": { width: WIDTH, boxSizing: "border-box" },
          }}
        >
          <Toolbar />
          {nav}
        </Drawer>
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: "none", md: "block" },
            "& .MuiDrawer-paper": {
              width: WIDTH, boxSizing: "border-box", borderRight: 1,
              borderColor: "divider", bgcolor: "#fbfcfa",
            },
          }}
        >
          <Toolbar />
          {nav}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, width: 0 }}>
        <Toolbar />
        <ApiModeBanner />
        <SyncWarningBanner />
        <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: "auto" }}>{children}</Box>
      </Box>
    </Box>
  );
}
