"use strict";

/**
 * SVX Reflector UI
 * - WebSocket snapshot + live updates
 * - Table + map (Leaflet)
 * - TG header hover tips + callsign hover tips (from config)
 * - Location formatting (Title-Case, space/- boundaries)
 * - Callsign info in map popup under location (from CALLSIGN_INFO_JSON)
 * - Auto-hide header after 10s; scroll reveals
 * - Mobile: callsign dot contains TG when talking (CSS controls visibility)
 */

const TG_LIST = [
  4, 6, 8, 23, 40, 50, 51, 52, 53, 54, 55, 58, 60, 1745, 1785, 2300, 2990, 8400,
  8401, 9000,
];

// Belgium bounds
const BE_SW = [49.48, 2.54];
const BE_NE = [51.55, 6.41];

const THEME_KEY = "svx-ui-theme";

// Persist UI choices (Show + Window) in localStorage
const UI_PREFS_KEY = "svx-ui-prefs-v1";

function loadUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveUiPrefs(prefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function restoreUiPrefs() {
  const p = loadUiPrefs();

  // Show toggles
  if (showRepeatersEl && typeof p.showRepeaters === "boolean")
    showRepeatersEl.checked = p.showRepeaters;

  if (showHotspotsEl && typeof p.showHotspots === "boolean")
    showHotspotsEl.checked = p.showHotspots;

  if (activeOnlyEl && typeof p.activeOnly === "boolean")
    activeOnlyEl.checked = p.activeOnly;

  // Window dropdown
  if (windowSelectEl && p.windowSec != null) {
    const v = String(p.windowSec);
    const exists = Array.from(windowSelectEl.options).some(
      (o) => o.value === v,
    );
    if (exists) windowSelectEl.value = v;
  }

  // Dark is already persisted by THEME_KEY in applyTheme()/initThemeDefaultDark()
}

function persistUiPrefs() {
  saveUiPrefs({
    showRepeaters: isChecked(showRepeatersEl, true),
    showHotspots: isChecked(showHotspotsEl, true),
    activeOnly: isChecked(activeOnlyEl, true),
    windowSec: selectNumber(windowSelectEl, 3600),
  });
}

/**
 * Optional local defaults (override / extend via /config.json)
 */
const LOCAL_TG_INFO = {};
const LOCAL_CALLSIGN_INFO = {};

// DOM (guarded where possible)
const titleEl = document.getElementById("title");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("tbody");
const theadRow = document.getElementById("theadRow");

// Tooltip element (auto-create if missing)
let tooltipEl = document.getElementById("tooltip");
if (!tooltipEl) {
  tooltipEl = document.createElement("div");
  tooltipEl.id = "tooltip";
  tooltipEl.className = "hidden";
  tooltipEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltipEl);
}

// Optional controls (may be hidden on mobile via CSS; still exist in DOM)
const showRepeatersEl = document.getElementById("showRepeaters");
const showHotspotsEl = document.getElementById("showHotspots");
const activeOnlyEl = document.getElementById("activeOnly");
const windowSelectEl = document.getElementById("windowSelect");
const themeToggleEl = document.getElementById("themeToggle");

// Helpers for optional controls
function isChecked(el, fallback) {
  return el ? !!el.checked : !!fallback;
}
function selectNumber(el, fallback) {
  if (!el) return fallback;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : fallback;
}

const state = {
  cfg: null,

  nodes: new Map(), // callsign -> node
  lastHeard: new Map(), // callsign -> ms
  prevTalker: new Map(), // callsign -> bool

  wsOk: false,

  // metadata (from config.json + LOCAL_* merged)
  tgInfo: {},
  csInfo: {},

  // tooltip tracking
  hoverTg: null,
  hoverCs: null,

  // map
  map: null,
  lightTiles: null,
  darkTiles: null,
  markerLayer: null,
  repMarkers: new Map(),
  hsMarkers: new Map(),
  beBounds: null,
  focusMode: "be",
  focusKey: "",
};

function isRepeater(callsign) {
  return String(callsign || "")
    .toUpperCase()
    .startsWith("ON0");
}

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim().replace(/O/g, "0").replace(/,/g, ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function msAgoLabel(deltaMs) {
  const s = Math.floor(deltaMs / 1000);
  if (!Number.isFinite(s) || s < 0) return "\u2014"; // em dash
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/**
 * Location formatting rule:
 * - First letter uppercase, rest lowercase
 * - After " " or "-" next letter uppercase
 * - If it looks like Maidenhead locator (KM25QG), keep uppercase
 */
function formatLocation(raw) {
  let s = (raw ?? "").toString().trim();
  if (!s) return "";

  if (/^[A-Za-z]{2}\d{2}[A-Za-z]{2}$/.test(s)) return s.toUpperCase();

  s = s.toLowerCase().replace(/\s+/g, " ").trim();

  let out = "";
  let capNext = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (capNext && /[a-z\u00C0-\u017F]/.test(ch)) {
      out += ch.toUpperCase();
      capNext = false;
    } else {
      out += ch;
      capNext = false;
    }
    if (ch === " " || ch === "-") capNext = true;
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Tooltip helpers ----------
function asTipText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const title = (v.title ?? "").toString().trim();
    const text = (v.text ?? v.desc ?? "").toString().trim();
    if (title && text) return `${title}\n${text}`;
    if (title) return title;
    if (text) return text;
    return JSON.stringify(v);
  }
  return String(v).trim();
}

function tgTip(tg) {
  const val = state.tgInfo[String(tg)];
  const txt = asTipText(val);
  if (!txt) return "";
  return `TG ${tg}\n${txt}`;
}

function csTip(cs) {
  const key = String(cs || "").toUpperCase();
  const val = state.csInfo[key];
  const txt = asTipText(val);
  if (!txt) return "";
  return `${key}\n${txt}`;
}

function showTip(text, x, y) {
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.classList.remove("hidden");
  moveTip(x, y);
}

function moveTip(x, y) {
  if (tooltipEl.classList.contains("hidden")) return;

  const pad = 12;
  const margin = 8;

  let left = x + pad;
  let top = y + pad;

  const rect = tooltipEl.getBoundingClientRect();

  if (left + rect.width > window.innerWidth - margin)
    left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - margin)
    top = y - rect.height - pad;

  left = Math.max(
    margin,
    Math.min(left, window.innerWidth - rect.width - margin),
  );
  top = Math.max(
    margin,
    Math.min(top, window.innerHeight - rect.height - margin),
  );

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTip() {
  tooltipEl.classList.add("hidden");
  tooltipEl.textContent = "";
}

function initHoverTooltips() {
  if (!theadRow || !tbody) return;

  function showTgFromEvent(e) {
    const th = e.target.closest("th[data-tg]");
    if (!th) {
      state.hoverTg = null;
      hideTip();
      return;
    }
    const tg = th.dataset.tg;
    const txt = tgTip(tg);
    if (!txt) {
      state.hoverTg = null;
      hideTip();
      return;
    }
    state.hoverTg = tg;
    state.hoverCs = null;
    showTip(txt, e.clientX, e.clientY);
  }

  theadRow.addEventListener("mouseover", (e) => showTgFromEvent(e));
  theadRow.addEventListener("mousemove", (e) => {
    if (!tooltipEl.classList.contains("hidden")) moveTip(e.clientX, e.clientY);
    const th = e.target.closest("th[data-tg]");
    const tg = th ? th.dataset.tg : null;
    if (tg && tg !== state.hoverTg) showTgFromEvent(e);
  });
  theadRow.addEventListener("mouseleave", () => {
    state.hoverTg = null;
    hideTip();
  });

  function showCsFromEvent(e) {
    const el = e.target.closest(".csHover[data-cs]");
    if (!el) {
      state.hoverCs = null;
      hideTip();
      return;
    }
    const cs = el.dataset.cs || "";
    const txt = csTip(cs);
    if (!txt) {
      state.hoverCs = null;
      hideTip();
      return;
    }
    state.hoverCs = cs;
    state.hoverTg = null;
    showTip(txt, e.clientX, e.clientY);
  }

  tbody.addEventListener("mouseover", (e) => showCsFromEvent(e));
  tbody.addEventListener("mousemove", (e) => {
    if (!tooltipEl.classList.contains("hidden")) moveTip(e.clientX, e.clientY);
    const el = e.target.closest(".csHover[data-cs]");
    const cs = el ? el.dataset.cs : null;
    if (cs && cs !== state.hoverCs) showCsFromEvent(e);
  });
  tbody.addEventListener("mouseleave", () => {
    state.hoverCs = null;
    hideTip();
  });

  // Hide tooltip on scroll (table container might be .tableFrame or .listWrap depending on your HTML)
  const scrollHost =
    document.querySelector(".tableFrame") ||
    document.querySelector(".listWrap") ||
    document.querySelector("main");
  if (scrollHost)
    scrollHost.addEventListener("scroll", () => hideTip(), { passive: true });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
}

// ---------- Auto-hide header ----------
function initAutoHideHeader() {
  const headerEl = document.querySelector("header");
  if (!headerEl) return;

  const AUTOHIDE_MS = 10_000;
  let timer = null;
  let hidden = false;

  function syncHeaderHeight() {
    const h = Math.max(48, Math.ceil(headerEl.getBoundingClientRect().height));
    document.documentElement.style.setProperty("--headerH", `${h}px`);
  }

  function applyHidden(nextHidden) {
    if (hidden === nextHidden) return;
    hidden = nextHidden;
    document.body.classList.toggle("header-hidden", hidden);

    if (state.map) {
      setTimeout(() => {
        try {
          state.map.invalidateSize();
        } catch {}
      }, 320);
    }
  }

  function armTimer() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => applyHidden(true), AUTOHIDE_MS);
  }

  function revealAndArm() {
    applyHidden(false);
    armTimer();
  }

  syncHeaderHeight();
  applyHidden(false);
  armTimer();

  window.addEventListener("resize", () => syncHeaderHeight(), {
    passive: true,
  });
  window.addEventListener("scroll", () => revealAndArm(), { passive: true });

  const scrollHost =
    document.querySelector(".tableFrame") ||
    document.querySelector(".listWrap") ||
    document.querySelector("main");
  if (scrollHost)
    scrollHost.addEventListener("scroll", () => revealAndArm(), {
      passive: true,
    });

  window.addEventListener("wheel", () => revealAndArm(), { passive: true });
  window.addEventListener("touchmove", () => revealAndArm(), { passive: true });
}

// ---------- THEME ----------
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  if (themeToggleEl) themeToggleEl.checked = dark;

  if (state.map) {
    if (dark) {
      if (state.map.hasLayer(state.lightTiles))
        state.map.removeLayer(state.lightTiles);
      if (!state.map.hasLayer(state.darkTiles))
        state.darkTiles.addTo(state.map);
    } else {
      if (state.map.hasLayer(state.darkTiles))
        state.map.removeLayer(state.darkTiles);
      if (!state.map.hasLayer(state.lightTiles))
        state.lightTiles.addTo(state.map);
    }
  }

  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {}
  renderAll();
}

function initThemeDefaultDark() {
  let dark = true;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light") dark = false;
    if (stored === "dark") dark = true;
  } catch {}
  applyTheme(dark);
}

if (themeToggleEl) {
  themeToggleEl.addEventListener("change", () =>
    applyTheme(themeToggleEl.checked),
  );
}

// ---------- TABLE HEADER ----------
function buildTgHeader() {
  if (!theadRow) return;

  Array.from(theadRow.querySelectorAll("th[data-tg]")).forEach((x) =>
    x.remove(),
  );

  for (const tg of TG_LIST) {
    const th = document.createElement("th");
    th.className = "tg";
    th.dataset.tg = String(tg);
    th.innerHTML = `<span>${tg}</span>`;
    theadRow.appendChild(th);
  }
}

// ---------- MAP ----------
function initMap() {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  const map = L.map("map", { worldCopyJump: true, zoomControl: true });
  state.map = map;

  state.lightTiles = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    },
  );

  state.darkTiles = L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      className: "tiles-dark-soft",
    },
  );

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  (isDark ? state.darkTiles : state.lightTiles).addTo(map);

  state.markerLayer = L.layerGroup().addTo(map);
  state.beBounds = L.latLngBounds([BE_SW, BE_NE]);
  map.fitBounds(state.beBounds, { padding: [20, 20] });
}

function coordInBelgium(lat, lon) {
  return (
    lat >= BE_SW[0] && lat <= BE_NE[0] && lon >= BE_SW[1] && lon <= BE_NE[1]
  );
}

function resetMapToBelgium() {
  if (!state.map) return;
  state.map.fitBounds(state.beBounds, { padding: [20, 20] });
  state.focusMode = "be";
  state.focusKey = "";
}

function callsignInfoText(callsign) {
  const key = String(callsign || "").toUpperCase();
  const val = state.csInfo ? state.csInfo[key] : null;
  return asTipText(val);
}

function popupHtmlForNode(callsign, locationText) {
  const cs = String(callsign || "").toUpperCase();
  const loc = String(locationText || "").trim();

  const info = callsignInfoText(cs);
  const infoBlock = info
    ? `<div style="margin-top:6px; white-space:pre-line; color:var(--muted);">${escapeHtml(info)}</div>`
    : "";

  return `<strong>${escapeHtml(cs)}</strong><br>${escapeHtml(loc)}${infoBlock}`;
}

function upsertMarker(mapKey, callsign, lat, lon, popupHtml) {
  let m = mapKey.get(callsign);
  if (!m) {
    m = L.circleMarker([lat, lon], {
      radius: 6,
      weight: 1,
      opacity: 1,
      fillOpacity: 0.8,
    });
    m.addTo(state.markerLayer);

    // Wider popup (adjust as you like)
    m.bindPopup(popupHtml, {
      maxWidth: 460,
      minWidth: 300,
      autoPanPadding: [20, 20],
    });

    mapKey.set(callsign, m);
  } else {
    m.setLatLng([lat, lon]);
    m.setPopupContent(popupHtml);
  }
  return m;
}

function removeMarker(mapKey, callsign) {
  const m = mapKey.get(callsign);
  if (m) {
    state.markerLayer.removeLayer(m);
    mapKey.delete(callsign);
  }
}

function setTalkLabel(marker, callsign, enabled) {
  try {
    if (enabled) {
      const txt = String(callsign || "").toUpperCase();
      if (!txt) return;

      if (marker.getTooltip && marker.getTooltip()) {
        marker.setTooltipContent(txt);
      } else {
        marker.bindTooltip(txt, {
          permanent: true,
          direction: "top",
          offset: [0, -10],
          className: "talkLabel",
          opacity: 0.96,
        });
      }
    } else {
      if (marker.getTooltip && marker.getTooltip()) marker.unbindTooltip();
    }
  } catch {}
}

function setRepeaterStyle(marker, node) {
  const accent = cssVar("--accent", "#A52A2A"); // RED while talking
  const ok = cssVar("--ok", "#35c48d"); // green when online
  const muted = "rgba(148,163,184,.55)";

  let color = muted;
  let radius = 5;
  let fillOpacity = 0.3;
  let weight = 1;

  if (node.online) {
    color = ok;
    fillOpacity = 0.55;
    radius = 6;
  }
  if (node.isTalker) {
    color = accent;
    fillOpacity = 1.0;
    radius = 9;
    weight = 3;
  }

  marker.setStyle({
    color,
    fillColor: color,
    radius,
    fillOpacity,
    weight,
    opacity: 1,
  });
  setTalkLabel(marker, node.callsign, !!node.isTalker);
}

function setHotspotStyle(marker, node) {
  const accent = cssVar("--accent", "#A52A2A"); // RED while talking
  const hs = cssVar("--hotspot", "#FFA502"); // ORANGE for hotspots

  let color = hs;
  let radius = 6;
  let fillOpacity = node.online ? 0.65 : 0.25;
  let weight = 1;

  // Talking overrides color/size
  if (node.isTalker) {
    color = accent;
    radius = 9;
    fillOpacity = 1.0;
    weight = 3;
  }

  marker.setStyle({
    color,
    fillColor: color,
    radius,
    fillOpacity,
    weight,
    opacity: 1,
  });

  // Only show callsign label when talking (avoids clutter)
  setTalkLabel(marker, node.callsign, !!node.isTalker);
}

function visibleTalkersOutsideBelgium() {
  const showRepeaters = isChecked(showRepeatersEl, true);
  const showHotspots = isChecked(showHotspotsEl, true);
  const activeOnly = isChecked(activeOnlyEl, true);

  const out = [];
  for (const n of state.nodes.values()) {
    if (!n.isTalker) continue;
    if (n.lat == null || n.lon == null) continue;

    const rep = isRepeater(n.callsign);
    if (rep && !showRepeaters) continue;
    if (!rep && !showHotspots) continue;
    if (activeOnly && !n.online) continue;

    if (!coordInBelgium(n.lat, n.lon)) out.push(n);
  }
  return out;
}

function updateMapFocus() {
  if (!state.map) return;

  const outside = visibleTalkersOutsideBelgium();
  const key = outside
    .map((n) => n.callsign)
    .sort()
    .join(",");

  if (outside.length > 0) {
    if (state.focusMode !== "out" || state.focusKey !== key) {
      const b = L.latLngBounds([BE_SW, BE_NE]);
      outside.forEach((n) => b.extend([n.lat, n.lon]));
      state.map.fitBounds(b, { padding: [30, 30] });
      state.focusMode = "out";
      state.focusKey = key;
    }
    return;
  }

  if (state.focusMode !== "be") resetMapToBelgium();
}

function updateMapMarkers() {
  if (!state.map) return;

  const showRepeaters = isChecked(showRepeatersEl, true);
  const showHotspots = isChecked(showHotspotsEl, true);
  const activeOnly = isChecked(activeOnlyEl, true);

  for (const n of state.nodes.values()) {
    const lat = toNumber(n.lat);
    const lon = toNumber(n.lon);
    if (lat == null || lon == null) continue;

    const rep = isRepeater(n.callsign);
    const loc = formatLocation(n.location || "");

    if (rep) {
      if (!showRepeaters) {
        removeMarker(state.repMarkers, n.callsign);
        continue;
      }
      if (activeOnly && !n.online) {
        removeMarker(state.repMarkers, n.callsign);
        continue;
      }

      const popup = popupHtmlForNode(n.callsign, loc);
      const m = upsertMarker(state.repMarkers, n.callsign, lat, lon, popup);
      setRepeaterStyle(m, { ...n, lat, lon });
    } else {
      // Hotspots: visible on map as well (orange), even when not talking
      if (!showHotspots) {
        removeMarker(state.hsMarkers, n.callsign);
        continue;
      }

      // Respect Active-only filter: if ON, hide offline hotspots
      if (activeOnly && !n.online) {
        removeMarker(state.hsMarkers, n.callsign);
        continue;
      }

      const popup = popupHtmlForNode(n.callsign, loc);
      const m = upsertMarker(state.hsMarkers, n.callsign, lat, lon, popup);
      setHotspotStyle(m, { ...n, lat, lon });
    }
  }

  // cleanup markers for removed nodes
  for (const cs of Array.from(state.repMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.repMarkers, cs);
  }
  for (const cs of Array.from(state.hsMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.hsMarkers, cs);
  }
  normalizeMarkerZOrder();
}

function normalizeMarkerZOrder() {
  // Put non-talking hotspots behind everything
  for (const [cs, m] of state.hsMarkers.entries()) {
    const n = state.nodes.get(cs);
    if (!m || !n) continue;
    if (!n.isTalker && m.bringToBack) m.bringToBack();
  }

  // Keep repeaters above hotspots (even when not talking)
  for (const [, m] of state.repMarkers.entries()) {
    if (m && m.bringToFront) m.bringToFront();
  }

  // Finally: all talkers on top (repeaters + hotspots)
  for (const n of state.nodes.values()) {
    if (!n.isTalker) continue;
    const m = isRepeater(n.callsign)
      ? state.repMarkers.get(n.callsign)
      : state.hsMarkers.get(n.callsign);
    if (m && m.bringToFront) m.bringToFront();
  }
}

// ---------- RENDER ----------
function renderStatus() {
  if (!statusEl) return;

  const online = Array.from(state.nodes.values()).filter(
    (n) => n.online,
  ).length;
  const offline = Array.from(state.nodes.values()).filter(
    (n) => !n.online,
  ).length;
  const talking = Array.from(state.nodes.values()).filter(
    (n) => n.isTalker,
  ).length;

  const dot = "\u2022"; // bullet
  const ell = "\u2026"; // ellipsis

  statusEl.textContent = state.wsOk
    ? `Connected ${dot} Online: ${online} ${dot} Offline: ${offline} ${dot} Talking: ${talking}`
    : `Disconnected ${dot} Reconnecting${ell}`;

  statusEl.className = "conn " + (state.wsOk ? "ok" : "bad");
}

function chooseTalkTg(node) {
  const tg = Number(node.tg || 0);
  if (node.isTalker && tg && TG_LIST.includes(tg)) return tg;

  if (
    node.isTalker &&
    Array.isArray(node.monitoredTGs) &&
    node.monitoredTGs.length
  ) {
    const first = Number(node.monitoredTGs[0]);
    if (TG_LIST.includes(first)) return first;
  }
  return 0;
}

function shouldShowInTable(node, nowMs) {
  const showRepeaters = isChecked(showRepeatersEl, true);
  const showHotspots = isChecked(showHotspotsEl, true);
  const activeOnly = isChecked(activeOnlyEl, true);

  const rep = isRepeater(node.callsign);
  if (rep && !showRepeaters) return false;
  if (!rep && !showHotspots) return false;

  if (activeOnly && !node.online) return false;

  const windowSec = selectNumber(windowSelectEl, 3600);
  const windowMs = windowSec * 1000;

  if (node.isTalker) return true;

  const last = state.lastHeard.get(node.callsign) || 0;

  // If Active-only is OFF: show offline nodes even if last-heard unknown
  if (!activeOnly && !node.online && !last) return true;

  if (!last) return false;
  return nowMs - last <= windowMs;
}

function renderTable() {
  if (!tbody) return;

  const now = Date.now();

  const rows = [];
  for (const n of state.nodes.values()) {
    if (!shouldShowInTable(n, now)) continue;
    const last = state.lastHeard.get(n.callsign) || 0;
    const ago = last ? now - last : Number.POSITIVE_INFINITY;
    rows.push({ n, last, ago });
  }

  rows.sort((a, b) => {
    if (!!a.n.isTalker !== !!b.n.isTalker) return a.n.isTalker ? -1 : 1;
    if (!!a.n.online !== !!b.n.online) return a.n.online ? -1 : 1;
    if (a.ago !== b.ago) return a.ago - b.ago;
    return a.n.callsign.localeCompare(b.n.callsign);
  });

  const html = rows
    .map(({ n, last }) => {
      // Left status dot (desktop)
      const dot = n.online
        ? `<span class="dotOnline"></span>`
        : `<span class="dotOffline"></span>`;

      // Heard time
      const heard = n.isTalker
        ? `<span class="timeNow">Now</span>`
        : last
          ? msAgoLabel(Date.now() - last)
          : "\u2014";

      const monitored = Array.isArray(n.monitoredTGs) ? n.monitoredTGs : [];
      const talkTg = chooseTalkTg(n);

      // TG matrix cells (desktop; mobile hides with CSS)
      const tgCells = TG_LIST.map((tg) => {
        if (n.isTalker && talkTg === tg)
          return `<td class="tg"><span class="tgTalkDot"></span></td>`;
        if (monitored.includes(tg))
          return `<td class="tg"><span class="tgCheck">&#10003;</span></td>`;
        return `<td class="tg"></td>`;
      }).join("");

      const trCls = n.isTalker ? "talkingRow" : "";
      const loc = formatLocation(n.location || "");

      // Mobile dot (shown only on mobile by CSS)
      const mDotText = n.isTalker && talkTg ? String(talkTg) : "";
      const mDotState = n.online ? "online" : "offline";
      const mDotTalk = n.isTalker ? " talking" : "";
      const mDotHtml = `<span class="mDot ${mDotState}${mDotTalk}">${escapeHtml(mDotText)}</span>`;

      return `
      <tr class="${trCls}">
        <td class="narrow center">${dot}</td>

        <td>
          <span class="csHover" data-cs="${escapeHtml(n.callsign)}">
            ${mDotHtml}<strong>${escapeHtml(n.callsign)}</strong>
          </span>
        </td>

        <td>${escapeHtml(loc)}</td>
        <td class="center">${heard}</td>
        ${tgCells}
      </tr>
    `;
    })
    .join("");

  tbody.innerHTML =
    html ||
    `<tr><td colspan="${4 + TG_LIST.length}" style="padding:14px;color:var(--muted)">No nodes in this window.</td></tr>`;
}

function renderAll() {
  renderStatus();
  renderTable();
  updateMapMarkers();
  updateMapFocus();
}

// ---------- WS HANDLING ----------
function ensureNodeFromSession(sess) {
  const cs = String(sess?.callsign || "").toUpperCase();
  if (!cs) return;
  if (state.nodes.has(cs)) return;

  let location = "";
  let lat = null;
  let lon = null;
  let monitoredTGs = [];
  let tg = 0;

  const hint = sess.node && typeof sess.node === "object" ? sess.node : null;
  if (hint) {
    location = (hint.nodeLocation || "").toString();
    tg = Number(hint.tg || 0) || 0;

    if (Array.isArray(hint.monitoredTGs)) {
      monitoredTGs = hint.monitoredTGs
        .map((x) => Number(x))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }
    if (hint.qth && typeof hint.qth === "object") {
      lat = toNumber(hint.qth.lat);
      lon = toNumber(hint.qth.long);
    }
  }

  state.nodes.set(cs, {
    callsign: cs,
    online: false,
    isTalker: false,
    tg,
    monitoredTGs,
    location,
    lat,
    lon,
  });
  state.prevTalker.set(cs, false);
}

function updateLastHeardFromSession(sess) {
  if (!sess) return;
  ensureNodeFromSession(sess);

  const cs = String(sess.callsign || "").toUpperCase();
  if (!cs) return;

  const ts = sess.end_ms || sess.start_ms;
  if (!ts) return;

  const old = state.lastHeard.get(cs) || 0;
  if (ts > old) state.lastHeard.set(cs, ts);
}

function applyNodeUpsert(node) {
  if (!node || typeof node !== "object") return;
  const cs = String(node.callsign || "").toUpperCase();
  if (!cs) return;

  const prev = state.nodes.get(cs) || { callsign: cs };

  const monitored = Array.isArray(node.monitoredTGs)
    ? node.monitoredTGs
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x))
        .sort((a, b) => a - b)
    : Array.isArray(prev.monitoredTGs)
      ? prev.monitoredTGs
      : [];

  const merged = {
    ...prev,
    ...node,
    callsign: cs,
    online: !!node.online,
    isTalker: !!node.isTalker,
    tg: Number(node.tg || 0) || 0,
    monitoredTGs: monitored,
    lat: toNumber(node.lat ?? prev.lat),
    lon: toNumber(node.lon ?? prev.lon),
    location: (node.location ?? prev.location ?? "").toString(),
  };

  state.nodes.set(cs, merged);

  const wasTalker = !!state.prevTalker.get(cs);
  const isTalker = !!merged.isTalker;

  if ((!wasTalker && isTalker) || (wasTalker && !isTalker)) {
    const t = Date.now();
    const old = state.lastHeard.get(cs) || 0;
    if (t > old) state.lastHeard.set(cs, t);
  }

  state.prevTalker.set(cs, isTalker);
}

function connectWs() {
  const wsUrl = state.cfg?.wsUrl;
  if (!wsUrl) return;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    state.wsOk = false;
    renderAll();
    setTimeout(connectWs, 2000);
    return;
  }

  ws.onopen = () => {
    state.wsOk = true;
    renderAll();
  };

  ws.onclose = () => {
    state.wsOk = false;
    renderAll();
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => {
    state.wsOk = false;
    renderAll();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "snapshot") {
      state.nodes.clear();
      state.prevTalker.clear();

      const nodes = Array.isArray(msg.nodes) ? msg.nodes : [];
      for (const n of nodes) applyNodeUpsert(n);

      const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      for (const s of sessions) updateLastHeardFromSession(s);

      const active = Array.isArray(msg.active) ? msg.active : [];
      for (const s of active) updateLastHeardFromSession(s);

      renderAll();
      return;
    }

    if (msg.type === "node_upsert" && msg.node) {
      applyNodeUpsert(msg.node);
      renderAll();
      return;
    }

    if (
      (msg.type === "talk_start" || msg.type === "talk_stop") &&
      msg.session
    ) {
      updateLastHeardFromSession(msg.session);
      renderAll();
      return;
    }
  };
}

// ---------- INIT ----------
function normalizeTgInfo(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k).trim();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

function normalizeCsInfo(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k).trim().toUpperCase();
    if (!key) continue;
    out[key] = v;
  }
  return out;
}

async function main() {
  initThemeDefaultDark();
  initMap();
  initAutoHideHeader();

  // config
  const cfgResp = await fetch("/config.json", { cache: "no-store" });
  state.cfg = await cfgResp.json();

  // Restore "Show" + "Window" settings from previous visit
  restoreUiPrefs();

  if (titleEl && state.cfg.title) titleEl.textContent = state.cfg.title;

  const tgMerged = { ...LOCAL_TG_INFO, ...(state.cfg.talkgroupInfo || {}) };
  const csMerged = {
    ...LOCAL_CALLSIGN_INFO,
    ...(state.cfg.callsignInfo || {}),
  };
  state.tgInfo = normalizeTgInfo(tgMerged);
  state.csInfo = normalizeCsInfo(csMerged);

  buildTgHeader();
  initHoverTooltips();

  // Controls -> rerender
  [showRepeatersEl, showHotspotsEl, activeOnlyEl, windowSelectEl].forEach(
    (el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        persistUiPrefs();
        renderAll();
      });
    },
  );

  // 1Hz refresh for "time since heard"
  setInterval(() => renderTable(), 1000);

  connectWs();
  renderAll();
}

main().catch(() => {
  if (statusEl) {
    statusEl.textContent = "Startup failed";
    statusEl.className = "conn bad";
  }
});
