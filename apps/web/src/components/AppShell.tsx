/**
 * The authenticated frame: fixed sidebar, farm in the top bar, content in a
 * card. The layout of cropti/farmlogs that the owner pointed at.
 *
 * Built for people who run a coffee farm and open this on a phone as often as
 * on a desk: short menu, large tap targets, plain Spanish. The day-to-day
 * modules sit up top; the rest live under "Más opciones" so the list does not
 * scroll on a phone.
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
import HarvestIcon from "@mui/icons-material/Grass";
import PriceChangeIcon from "@mui/icons-material/PriceChange";
import LockIcon from "@mui/icons-material/Lock";
import { useAuth } from "../auth/AuthContext";
import { visibleModules, type ModuleDef } from "../auth/permissions";
import { ApiModeBanner } from "./ApiModeBanner";
import { GREEN_DARK } from "../theme";

/** Wide enough for large labels; still fits a phone drawer. */
const WIDTH = 280;

const ICONS: Record<string, ReactNode> = {
  dashboard: <DashboardIcon fontSize="medium" />,
  harvest: <HarvestIcon fontSize="medium" />,
  terrain: <TerrainIcon fontSize="medium" />,
  people: <PeopleIcon fontSize="medium" />,
  agriculture: <AgricultureIcon fontSize="medium" />,
  task: <TaskIcon fontSize="medium" />,
  receipt: <ReceiptIcon fontSize="medium" />,
  sell: <SellIcon fontSize="medium" />,
  payments: <PaymentsIcon fontSize="medium" />,
  price: <PriceChangeIcon fontSize="medium" />,
  inventory: <InventoryIcon fontSize="medium" />,
  settings: <SettingsIcon fontSize="medium" />,
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  administrator: "Administrador",
  weigher: "Pesador",
};

function NavItem({
  module: m,
  selected,
  future,
  onNavigate,
}: {
  module: ModuleDef;
  selected: boolean;
  future: boolean;
  onNavigate: () => void;
}) {
  const item = (
    <ListItemButton
      component={future ? "div" : RouterLink}
      to={future ? undefined : m.path}
      selected={selected}
      disabled={future}
      onClick={onNavigate}
      sx={{
        mx: 1,
        borderRadius: 2,
        mb: 0.5,
        minHeight: 52,
        py: 1.25,
        "&.Mui-selected": { bgcolor: "#e6f0e4", color: GREEN_DARK },
        "&.Mui-selected .MuiListItemIcon-root": { color: GREEN_DARK },
      }}
    >
      <ListItemIcon sx={{ minWidth: 44 }}>
        {future ? <LockIcon /> : ICONS[m.icon]}
      </ListItemIcon>
      <ListItemText
        primary={m.label}
        slotProps={{
          primary: { fontWeight: selected ? 700 : 600, fontSize: 17 },
        }}
      />
      {/* "S4" means nothing outside this team. What a person needs to know
          about a greyed-out entry is that it is not here yet. */}
      {future && (
        <Chip size="small" label="pronto" sx={{ height: 22, fontSize: 12 }} />
      )}
    </ListItemButton>
  );

  if (!future) return item;
  return (
    <Tooltip
      title="Esta parte todavía no está lista. Llega en una próxima versión."
      placement="right"
    >
      <span>{item}</span>
    </Tooltip>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, principal, logout, readOnly } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);

  const visible = visibleModules(principal);
  const main = visible.filter((m) => m.group === "main");
  const more = visible.filter((m) => m.group === "more");

  const renderGroup = (items: ModuleDef[]) =>
    items.map((m) => {
      const future = !m.available;
      const selected = location.pathname.startsWith(m.path);
      return (
        <NavItem
          key={m.key}
          module={m}
          selected={selected}
          future={future}
          onNavigate={() => setMobileOpen(false)}
        />
      );
    });

  const nav = (
    <Box sx={{ py: 1.5 }}>
      <List disablePadding>{renderGroup(main)}</List>
      {more.length > 0 && (
        <>
          <Typography
            sx={{
              px: 2.5,
              pt: 2,
              pb: 1,
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "text.secondary",
            }}
          >
            Más opciones
          </Typography>
          <List disablePadding>{renderGroup(more)}</List>
        </>
      )}
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
        <Toolbar sx={{ gap: 2, minHeight: { xs: 64, sm: 68 } }}>
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
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: GREEN_DARK,
              textDecoration: "none",
              fontSize: { xs: 22, sm: 24 },
            }}
          >
            BÁSCULA
          </Typography>

          <Divider orientation="vertical" flexItem sx={{ my: 1.5, display: { xs: "none", sm: "block" } }} />

          <Typography
            sx={{
              fontWeight: 600,
              fontSize: 17,
              display: { xs: "none", sm: "block" },
            }}
          >
            {user?.farm?.name}
          </Typography>

          {readOnly && (
            <Chip size="small" color="error" label="Suspendida · solo lectura" />
          )}

          <Box sx={{ flex: 1 }} />

          <Stack direction="row" alignItems="center" spacing={1}>
            <Chip
              size="medium"
              variant="outlined"
              label={ROLE_LABEL[principal.role]}
              sx={{ display: { xs: "none", sm: "inline-flex" }, fontSize: 14 }}
            />
            <IconButton onClick={(e) => setUserMenu(e.currentTarget)} aria-label="Cuenta">
              <Avatar sx={{ width: 40, height: 40, bgcolor: GREEN_DARK, fontSize: 16 }}>
                {user?.name?.[0] ?? "?"}
              </Avatar>
            </IconButton>
          </Stack>

          <Menu anchorEl={userMenu} open={!!userMenu} onClose={() => setUserMenu(null)}>
            <MenuItem disabled sx={{ fontSize: 16 }}>
              {user?.email}
            </MenuItem>
            <Divider />
            <MenuItem
              sx={{ fontSize: 17, minHeight: 48 }}
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
              width: WIDTH,
              boxSizing: "border-box",
              borderRight: 1,
              borderColor: "divider",
              bgcolor: "#fbfcfa",
            },
          }}
        >
          <Toolbar />
          {nav}
        </Drawer>
      </Box>

      <Box component="main" sx={{ flexGrow: 1, width: 0 }}>
        <Toolbar sx={{ minHeight: { xs: 64, sm: 68 } }} />
        <ApiModeBanner />
        <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: "auto" }}>{children}</Box>
      </Box>
    </Box>
  );
}
