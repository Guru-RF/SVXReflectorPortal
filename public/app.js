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
 *
 * Updates:
 * - Overlapping markers: spiderfy on click with TWO guide rings (bigger radius + spacing).
 */

// Populated from /config.json (TG_INFO_JSON in env.yaml) at startup.
// Default kept only as a fallback in case the config has no talkgroup info.
let TG_LIST = [
  4, 6, 8, 23, 40, 50, 51, 52, 53, 54, 55, 58, 60, 1745, 1785, 2300, 2990, 8400,
  8401, 9000,
];

// Debug logging — enable with ?debug=1 in the URL
const DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debug");
function dlog(...args) {
  if (DEBUG) console.log("[svx]", ...args);
}

// Belgium bounds
const BE_SW = [49.48, 2.54];
const BE_NE = [51.55, 6.41];

const THEME_KEY = "svx-ui-theme";
const MAP_HOME_KEY = "svx-map-home-v1";
const UI_PREFS_KEY = "svx-ui-prefs-v1";

// Overlap / spiderfy tuning
const OVERLAP_DECIMALS = 6; // rounding for "same coordinate" detection
const SPIDER_R1_PX = 56; // ring 1 radius (px)
const SPIDER_R2_PX = 96; // ring 2 radius (px)
const SPIDER_R1_CAP = 10; // max markers on ring 1
const SPIDER_R2_CAP = 22; // max markers on ring 2 (total 32)
const SPIDER_SEGMENTS = 72; // ring smoothness

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

  if (showRepeatersEl && typeof p.showRepeaters === "boolean")
    showRepeatersEl.checked = p.showRepeaters;

  if (showHotspotsEl && typeof p.showHotspots === "boolean")
    showHotspotsEl.checked = p.showHotspots;

  if (activeOnlyEl && typeof p.activeOnly === "boolean")
    activeOnlyEl.checked = p.activeOnly;

  if (windowSelectEl && p.windowSec != null) {
    const v = String(p.windowSec);
    const exists = Array.from(windowSelectEl.options).some(
      (o) => o.value === v,
    );
    if (exists) windowSelectEl.value = v;
  }
}

function persistUiPrefs() {
  saveUiPrefs({
    showRepeaters: isChecked(showRepeatersEl, true),
    showHotspots: isChecked(showHotspotsEl, true),
    activeOnly: isChecked(activeOnlyEl, true),
    windowSec: selectNumber(windowSelectEl, 3600),
  });
}

/** Optional local defaults (override / extend via /config.json) */
const LOCAL_TG_INFO = {};
const LOCAL_CALLSIGN_INFO = {};

// DOM
const titleEl = document.getElementById("title");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("tbody");
const theadRow = document.getElementById("theadRow");

// Tooltip element
let tooltipEl = document.getElementById("tooltip");
if (!tooltipEl) {
  tooltipEl = document.createElement("div");
  tooltipEl.id = "tooltip";
  tooltipEl.className = "hidden";
  tooltipEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltipEl);
}

// Controls
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

  homeView: null,
  mapAutoMove: false, // true while WE (code) change the map view

  wsOk: false,

  // metadata
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
  focusMode: "home",
  focusKey: "",

  // overlap / spiderfy
  overlapIndex: new Map(), // coordKey -> markers[]
  spiderKey: "",
  spiderMarkers: [],
  spiderRings: [], // leaflet polylines
};

function isRepeater(callsign) {
  return String(callsign || "")
    .toUpperCase()
    .startsWith("ON0");
}

// Virtual callsigns (AI audio-detection on a repeater) contain a "/".
// They have no real session, so we treat them as always online.
function isVirtual(callsign) {
  return String(callsign || "").includes("/");
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
  if (!Number.isFinite(s) || s < 0) return "\u2014";
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

function formatLocation(raw) {
  let s = (raw ?? "").toString().trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}\d{2}[A-Za-z]{2}$/.test(s)) return s.toUpperCase();

  s = s.toLowerCase().replace(/\s+/g, " ").trim();

  let out = "";
  let capNext = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (capNext && /[a-z\u00C0-\u017F]/.test(ch)) out += ch.toUpperCase();
    else out += ch;
    capNext = ch === " " || ch === "-";
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

if (themeToggleEl)
  themeToggleEl.addEventListener("change", () =>
    applyTheme(themeToggleEl.checked),
  );

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

// ---------- Map home view persistence ----------
function loadMapHome() {
  try {
    const raw = localStorage.getItem(MAP_HOME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (
      !Number.isFinite(v.lat) ||
      !Number.isFinite(v.lng) ||
      !Number.isFinite(v.zoom)
    )
      return null;
    return { lat: v.lat, lng: v.lng, zoom: v.zoom };
  } catch {
    return null;
  }
}

function saveMapHomeFromMap() {
  if (!state.map) return;
  const c = state.map.getCenter();
  const z = state.map.getZoom();
  const v = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), zoom: z };
  state.homeView = v;
  try {
    localStorage.setItem(MAP_HOME_KEY, JSON.stringify(v));
  } catch {}
}

function goHomeView(animated = true) {
  if (!state.map) return;

  const v = state.homeView || loadMapHome();
  state.homeView = v || null;

  state.mapAutoMove = true;
  if (v) state.map.setView([v.lat, v.lng], v.zoom, { animate: animated });
  else state.map.fitBounds(state.beBounds, { padding: [20, 20] });

  state.focusMode = "home";
  state.focusKey = "";
}

function addCenterControl() {
  if (!state.map || typeof L === "undefined") return;

  const CenterControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      const btn = L.DomUtil.create("a", "leaflet-control-center", container);

      btn.href = "#";
      btn.title = "Center map (reset to default)";
      btn.setAttribute("aria-label", "Center map (reset to default)");
      btn.innerHTML = "&#x2316;"; // ⌖

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.preventDefault(e);
        try {
          localStorage.removeItem(MAP_HOME_KEY);
        } catch {}
        state.homeView = null;
        goHomeView(true);
      });

      return container;
    },
  });

  state.map.addControl(new CenterControl());
}

// ---------- Overlap / spiderfy helpers ----------
function coordKey(lat, lon) {
  return `${Number(lat).toFixed(OVERLAP_DECIMALS)},${Number(lon).toFixed(OVERLAP_DECIMALS)}`;
}

function ringLatLngs(baseLatLng, radiusPx) {
  const pts = [];
  const center = state.map.latLngToLayerPoint(baseLatLng);
  for (let i = 0; i <= SPIDER_SEGMENTS; i++) {
    const a = (i / SPIDER_SEGMENTS) * Math.PI * 2;
    const pt = L.point(
      center.x + radiusPx * Math.cos(a),
      center.y + radiusPx * Math.sin(a),
    );
    pts.push(state.map.layerPointToLatLng(pt));
  }
  return pts;
}

function unspiderfy() {
  if (!state.map) return;

  if (state.spiderMarkers && state.spiderMarkers.length) {
    for (const m of state.spiderMarkers) {
      if (m && m._svxBaseLatLng) {
        try {
          m.setLatLng(m._svxBaseLatLng);
        } catch {}
      }
    }
  }

  if (state.spiderRings && state.spiderRings.length) {
    for (const r of state.spiderRings) {
      try {
        state.map.removeLayer(r);
      } catch {}
    }
  }

  state.spiderMarkers = [];
  state.spiderRings = [];
  state.spiderKey = "";
}

function rebuildOverlapIndex() {
  state.overlapIndex = new Map();
  function addMarker(m) {
    if (!m || !m._svxBaseKey) return;
    const key = m._svxBaseKey;
    const arr = state.overlapIndex.get(key) || [];
    arr.push(m);
    state.overlapIndex.set(key, arr);
  }
  for (const m of state.repMarkers.values()) addMarker(m);
  for (const m of state.hsMarkers.values()) addMarker(m);
}

function applyOverlapOutline() {
  // Visual hint: if multiple markers share the exact same coordinates,
  // give them a thick outline so users can see "there is more here"
  // even before clicking (spiderfy).
  const ring = cssVar("--overlap-ring", "#E7E2C6");
  const minWeight = 4;

  const all = [
    ...Array.from(state.repMarkers.values()),
    ...Array.from(state.hsMarkers.values()),
  ];

  for (const m of all) {
    if (!m || typeof m.setStyle !== "function") continue;

    const key = m._svxBaseKey;
    const group = key ? state.overlapIndex.get(key) : null;
    const count = group ? group.length : 1;

    if (count > 1) {
      const w = Math.max(Number(m.options?.weight) || 1, minWeight);
      m.setStyle({ color: ring, weight: w, opacity: 1 });
    }
  }
}

function placeOnRing(markers, baseLatLng, radiusPx, offsetAngle = 0) {
  const center = state.map.latLngToLayerPoint(baseLatLng);
  const n = markers.length;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const a = offsetAngle + (i / n) * Math.PI * 2;
    const pt = L.point(
      center.x + radiusPx * Math.cos(a),
      center.y + radiusPx * Math.sin(a),
    );
    const ll = state.map.layerPointToLatLng(pt);
    try {
      markers[i].setLatLng(ll);
    } catch {}
  }
}

function spiderfyKey(key) {
  if (!state.map || typeof L === "undefined") return;

  const group = state.overlapIndex.get(key) || [];
  if (group.length <= 1) return;
  if (state.spiderKey === key) return;

  unspiderfy();

  const sorted = group.slice().sort((a, b) => {
    const at = a?._svxIsTalker ? 1 : 0;
    const bt = b?._svxIsTalker ? 1 : 0;
    if (at !== bt) return bt - at;
    const ac = a?._svxCallsign || "";
    const bc = b?._svxCallsign || "";
    return ac.localeCompare(bc);
  });

  const base = sorted[0]._svxBaseLatLng;
  if (!base) return;

  const ringColor = cssVar("--spider-ring", cssVar("--border", "#94a3b8"));
  const r1 = L.polyline(ringLatLngs(base, SPIDER_R1_PX), {
    color: ringColor,
    weight: 2,
    opacity: 0.55,
    dashArray: "6 6",
    interactive: false,
  }).addTo(state.map);

  const r2 = L.polyline(ringLatLngs(base, SPIDER_R2_PX), {
    color: ringColor,
    weight: 2,
    opacity: 0.35,
    dashArray: "2 8",
    interactive: false,
  }).addTo(state.map);

  state.spiderRings = [r1, r2];

  const ring1 = sorted.slice(0, Math.min(sorted.length, SPIDER_R1_CAP));
  const ring2 = sorted.slice(
    ring1.length,
    Math.min(sorted.length, SPIDER_R1_CAP + SPIDER_R2_CAP),
  );
  const rest = sorted.slice(ring1.length + ring2.length);

  placeOnRing(ring1, base, SPIDER_R1_PX, 0);
  placeOnRing(ring2, base, SPIDER_R2_PX, Math.PI / 10);
  if (rest.length) placeOnRing(rest, base, SPIDER_R2_PX + 34, Math.PI / 6);

  state.spiderKey = key;
  state.spiderMarkers = sorted;

  normalizeMarkerZOrder();
}

function bindSpiderfyClick(marker) {
  if (!marker || marker._svxSpiderBound) return;
  marker._svxSpiderBound = true;

  marker.on("click", (ev) => {
    try {
      if (ev && ev.originalEvent && typeof L !== "undefined")
        L.DomEvent.stopPropagation(ev.originalEvent);
    } catch {}

    const key = marker._svxBaseKey;
    if (!key) return;

    const group = state.overlapIndex.get(key) || [];
    if (group.length > 1 && state.spiderKey !== key) {
      try {
        marker.closePopup();
      } catch {}
      spiderfyKey(key);
      return;
    }
  });
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

  addCenterControl();

  state.homeView = loadMapHome();
  state.mapAutoMove = true;
  if (state.homeView)
    map.setView([state.homeView.lat, state.homeView.lng], state.homeView.zoom, {
      animate: false,
    });
  else map.fitBounds(state.beBounds, { padding: [20, 20] });

  state.focusMode = "home";
  state.focusKey = "";

  // Collapse spiderfy on background click / move / zoom
  map.on("click", () => unspiderfy());
  map.on("zoomstart", () => unspiderfy());
  map.on("movestart", () => unspiderfy());

  map.on("moveend", () => {
    if (state.mapAutoMove) {
      state.mapAutoMove = false;
      return;
    }
    saveMapHomeFromMap();
    if (visibleTalkersOutsideBelgium().length === 0) {
      state.focusMode = "home";
      state.focusKey = "";
    }
  });
}

function coordInBelgium(lat, lon) {
  return (
    lat >= BE_SW[0] && lat <= BE_NE[0] && lon >= BE_SW[1] && lon <= BE_NE[1]
  );
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

      if (marker.getTooltip && marker.getTooltip())
        marker.setTooltipContent(txt);
      else {
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
  const accent = cssVar("--accent", "#A52A2A");
  const ok = cssVar("--ok", "#35c48d");
  const virtual = cssVar("--virtual", "#3b82f6");
  const muted = "rgba(148,163,184,.55)";

  let color = muted;
  let radius = 5;
  let fillOpacity = 0.3;
  let weight = 1;

  if (node.online) {
    color = node.isVirtual ? virtual : ok;
    fillOpacity = 0.55;
    radius = 6;
  }
  if (node.isTalker) {
    color = accent;
    fillOpacity = 1.0;
    radius = 8;
    weight = 4;
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
  const accent = cssVar("--accent", "#A52A2A");
  const hs = cssVar("--hotspot", "#FFA502");
  const virtual = cssVar("--virtual", "#3b82f6");

  let color = node.isVirtual ? virtual : hs;
  let radius = 6;
  let fillOpacity = node.online ? 0.65 : 0.25;
  let weight = 1;

  if (node.isTalker) {
    color = accent;
    radius = 8;
    fillOpacity = 1.0;
    weight = 4;
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
    if (!rep && !showHotspots && !n.isTalker) continue;
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
      state.mapAutoMove = true;
      state.map.fitBounds(b, { padding: [30, 30] });
      state.focusMode = "out";
      state.focusKey = key;
    }
    return;
  }

  if (state.focusMode !== "home") goHomeView();
}

function updateMapMarkers() {
  if (!state.map) return;

  unspiderfy();

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

      m._svxCallsign = String(n.callsign || "").toUpperCase();
      m._svxIsTalker = !!n.isTalker;
      m._svxBaseLatLng = L.latLng(lat, lon);
      m._svxBaseKey = coordKey(lat, lon);
      bindSpiderfyClick(m);

      setRepeaterStyle(m, { ...n, lat, lon });
    } else {
      if (!showHotspots && !n.isTalker) {
        removeMarker(state.hsMarkers, n.callsign);
        continue;
      }

      if (!showHotspots && n.isTalker) {
        // allow talking hotspot even if hotspots are disabled
      } else {
        if (activeOnly && !n.online) {
          removeMarker(state.hsMarkers, n.callsign);
          continue;
        }
      }

      const popup = popupHtmlForNode(n.callsign, loc);
      const m = upsertMarker(state.hsMarkers, n.callsign, lat, lon, popup);

      m._svxCallsign = String(n.callsign || "").toUpperCase();
      m._svxIsTalker = !!n.isTalker;
      m._svxBaseLatLng = L.latLng(lat, lon);
      m._svxBaseKey = coordKey(lat, lon);
      bindSpiderfyClick(m);

      setHotspotStyle(m, { ...n, lat, lon });
    }
  }

  for (const cs of Array.from(state.repMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.repMarkers, cs);
  }
  for (const cs of Array.from(state.hsMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.hsMarkers, cs);
  }

  rebuildOverlapIndex();
  applyOverlapOutline();
  normalizeMarkerZOrder();
}

function normalizeMarkerZOrder() {
  for (const [cs, m] of state.hsMarkers.entries()) {
    const n = state.nodes.get(cs);
    if (!m || !n) continue;
    if (!n.isTalker && m.bringToBack) m.bringToBack();
  }
  for (const [, m] of state.repMarkers.entries()) {
    if (m && m.bringToFront) m.bringToFront();
  }
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

  const dot = "\u2022";
  const ell = "\u2026";

  statusEl.textContent = state.wsOk
    ? `Connected ${dot} Online: ${online} ${dot} Offline: ${offline} ${dot} Talking: ${talking}`
    : `Disconnected ${dot} Reconnecting${ell}`;

  statusEl.className = "conn " + (state.wsOk ? "ok" : "bad");
}

function chooseTalkTg(node) {
  const tg = Number(node.tg || 0);
  if (node.isTalker && tg) return tg;

  if (
    node.isTalker &&
    Array.isArray(node.monitoredTGs) &&
    node.monitoredTGs.length
  ) {
    const first = Number(node.monitoredTGs[0]);
    if (first) return first;
  }
  return 0;
}

function shouldShowInTableDebug(node, nowMs) {
  const showRepeaters = isChecked(showRepeatersEl, true);
  const showHotspots = isChecked(showHotspotsEl, true);
  const activeOnly = isChecked(activeOnlyEl, true);

  const rep = isRepeater(node.callsign);

  if (rep && !showRepeaters) return { show: false, reason: "type" };
  if (!rep && !showHotspots && !node.isTalker)
    return { show: false, reason: "type" };

  if (node.isTalker) return { show: true };
  if (node.online) return { show: true };

  // Offline path: keep recently-heard nodes visible even when Active-only is on,
  // so a node that flips offline post-snapshot doesn't vanish from the list.
  const last = state.lastHeard.get(node.callsign) || 0;
  const windowMs = selectNumber(windowSelectEl, 3600) * 1000;
  const inWindow = last > 0 && nowMs - last <= windowMs;

  if (activeOnly) {
    return inWindow ? { show: true } : { show: false, reason: "active" };
  }
  return { show: true };
}

function shouldShowInTable(node, nowMs) {
  return shouldShowInTableDebug(node, nowMs).show;
}

function renderTable() {
  if (!tbody) return;

  const now = Date.now();

  const rows = [];
  let kept = 0;
  let droppedReason = { type: 0, active: 0, stale: 0 };
  for (const n of state.nodes.values()) {
    const verdict = shouldShowInTableDebug(n, now);
    if (!verdict.show) {
      droppedReason[verdict.reason] = (droppedReason[verdict.reason] || 0) + 1;
      continue;
    }
    kept++;
    const last = state.lastHeard.get(n.callsign) || 0;
    const ago = last ? now - last : Number.POSITIVE_INFINITY;
    rows.push({ n, last, ago });
  }
  if (DEBUG) {
    dlog(
      `render: ${state.nodes.size} known → ${kept} shown. dropped:`,
      droppedReason,
    );
  }

  rows.sort((a, b) => {
    if (!!a.n.isTalker !== !!b.n.isTalker) return a.n.isTalker ? -1 : 1;
    if (!!a.n.online !== !!b.n.online) return a.n.online ? -1 : 1;
    if (a.ago !== b.ago) return a.ago - b.ago;
    return a.n.callsign.localeCompare(b.n.callsign);
  });

  const html = rows
    .map(({ n, last }) => {
      const dot = n.isVirtual
        ? `<span class="dotVirtual"></span>`
        : n.online
          ? `<span class="dotOnline"></span>`
          : `<span class="dotOffline"></span>`;

      const heard = n.isTalker
        ? `<span class="timeNow">Now</span>`
        : last
          ? msAgoLabel(Date.now() - last)
          : "\u2014";

      const monitored = Array.isArray(n.monitoredTGs) ? n.monitoredTGs : [];
      const talkTg = chooseTalkTg(n);
      const talkTgInList = !!talkTg && TG_LIST.includes(talkTg);

      let tgCells;
      if (n.isTalker && talkTg && !talkTgInList) {
        tgCells = `<td class="tg tgOther" colspan="${TG_LIST.length}"><span class="tgTalkDot"></span><span class="tgOtherLabel">TG ${escapeHtml(String(talkTg))}</span></td>`;
      } else {
        tgCells = TG_LIST.map((tg) => {
          if (n.isTalker && talkTg === tg)
            return `<td class="tg"><span class="tgTalkDot"></span></td>`;
          if (monitored.includes(tg))
            return `<td class="tg"><span class="tgCheck">&#10003;</span></td>`;
          return `<td class="tg"></td>`;
        }).join("");
      }

      const trCls = n.isTalker ? "talkingRow" : "";
      const loc = formatLocation(n.location || "");

      const mDotText = n.isTalker && talkTg ? String(talkTg) : "";
      const mDotState = n.isVirtual
        ? "virtual"
        : n.online
          ? "online"
          : "offline";
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
    online: isVirtual(cs),
    isVirtual: isVirtual(cs),
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

  const virtual = isVirtual(cs);
  const merged = {
    ...prev,
    ...node,
    callsign: cs,
    online: virtual ? true : !!node.online,
    isVirtual: virtual,
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
      const incoming = Array.isArray(msg.nodes) ? msg.nodes : [];
      const incomingOnline = incoming.filter((n) => n && n.online).length;
      dlog(
        `snapshot: ${incoming.length} nodes (${incomingOnline} online), ${(msg.sessions || []).length} sessions, ${(msg.active || []).length} active. Preserving ${state.nodes.size} known.`,
      );
      if (DEBUG && incoming.length) {
        dlog(
          "  callsigns:",
          incoming
            .map((n) => `${n.callsign}(${n.online ? "on" : "off"})`)
            .join(", "),
        );
      }

      // Preserve previously-known nodes across snapshots — mark them offline
      // (virtual ones stay online) and let the incoming snapshot re-confirm
      // those still present. Without this, a reflector reload that arrives
      // with a small/empty snapshot would briefly wipe the entire list.
      for (const [cs, n] of state.nodes) {
        n.online = isVirtual(cs);
        n.isTalker = false;
      }
      state.prevTalker.clear();

      for (const n of incoming) applyNodeUpsert(n);

      const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      for (const s of sessions) updateLastHeardFromSession(s);

      const active = Array.isArray(msg.active) ? msg.active : [];
      for (const s of active) updateLastHeardFromSession(s);

      renderAll();
      return;
    }

    if (msg.type === "node_upsert" && msg.node) {
      dlog(
        `node_upsert: ${msg.node.callsign} online=${msg.node.online} isTalker=${msg.node.isTalker}`,
      );
      applyNodeUpsert(msg.node);
      renderAll();
      return;
    }

    if (
      (msg.type === "talk_start" || msg.type === "talk_stop") &&
      msg.session
    ) {
      dlog(`${msg.type}: ${msg.session.callsign}`);
      updateLastHeardFromSession(msg.session);
      renderAll();
      return;
    }

    dlog("unhandled msg:", msg.type);
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

  const cfgResp = await fetch("/config.json", { cache: "no-store" });
  state.cfg = await cfgResp.json();

  restoreUiPrefs();

  if (titleEl && state.cfg.title) titleEl.textContent = state.cfg.title;

  const tgMerged = { ...LOCAL_TG_INFO, ...(state.cfg.talkgroupInfo || {}) };
  const csMerged = {
    ...LOCAL_CALLSIGN_INFO,
    ...(state.cfg.callsignInfo || {}),
  };
  state.tgInfo = normalizeTgInfo(tgMerged);
  state.csInfo = normalizeCsInfo(csMerged);

  const configuredTgs = Object.keys(state.tgInfo)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (configuredTgs.length) TG_LIST = configuredTgs;

  buildTgHeader();
  initHoverTooltips();

  [showRepeatersEl, showHotspotsEl, activeOnlyEl, windowSelectEl].forEach(
    (el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        persistUiPrefs();
        renderAll();
      });
    },
  );

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
