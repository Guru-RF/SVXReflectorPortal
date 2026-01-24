"use strict";

/**
 * Adds:
 * - TG header hover tooltips (from config)
 * - Callsign hover tooltips (from config)
 * - Location formatting: Title-case with space / '-' boundaries
 */

const TG_LIST = [
  4, 6, 8, 23, 40, 50, 51, 52, 53, 54, 55, 58, 60, 1745, 1785, 2300, 2990, 8400,
  8401, 9000,
];

// Belgium bounds
const BE_SW = [49.48, 2.54];
const BE_NE = [51.55, 6.41];

const THEME_KEY = "svx-ui-theme";

/**
 * Optional LOCAL defaults (if you prefer editing the JS instead of Cloud Run env vars):
 * Keys for TG can be number or string.
 * Callsigns should be uppercase.
 */
const LOCAL_TG_INFO = {
  // "8": "Belgium wide TG\nUsed for general traffic",
  // "1745": "Example: Event TG\nSome details here"
};

const LOCAL_CALLSIGN_INFO = {
  // "ON0APS": "Appels repeater\nSysop: ON1DGR\nUHF",
  // "ON0BRK": "Brakel repeater\n..."
};

// DOM
const titleEl = document.getElementById("title");
const statusEl = document.getElementById("status");
const tbody = document.getElementById("tbody");
const theadRow = document.getElementById("theadRow");
let tooltipEl = document.getElementById("tooltip");
if (!tooltipEl) {
  // Fallback: create it if index.html doesn't have it or it's placed after the script
  tooltipEl = document.createElement("div");
  tooltipEl.id = "tooltip";
  tooltipEl.className = "hidden";
  tooltipEl.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltipEl);
}

const showRepeatersEl = document.getElementById("showRepeaters");
const showHotspotsEl = document.getElementById("showHotspots");
const activeOnlyEl = document.getElementById("activeOnly");
const windowSelectEl = document.getElementById("windowSelect");
const themeToggleEl = document.getElementById("themeToggle");

// State
const state = {
  cfg: null,

  nodes: new Map(), // callsign -> node
  lastHeard: new Map(), // callsign -> ms
  prevTalker: new Map(),

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
  if (!Number.isFinite(s) || s < 0) return "—";
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
 * - After " " or "-" the next letter is uppercase
 * - If it looks like a Maidenhead locator (KM25QG), keep uppercase
 */
function formatLocation(raw) {
  let s = (raw ?? "").toString().trim();
  if (!s) return "";

  // Keep Maidenhead-like locators (2 letters + 2 digits + 2 letters)
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

function callsignInfoText(callsign) {
  const key = String(callsign || "").toUpperCase();
  const val = state.csInfo ? state.csInfo[key] : null;
  return asTipText(val); // uses your existing helper
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

// ---------- Tooltip helpers ----------
function asTipText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    // allow {title:"...", text:"..."} if you want later
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

  // TG header hover
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

  // Callsign hover (event delegation)
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

  // Hide tooltip on scroll (prevents it "floating" over wrong row)
  const tableFrame = document.querySelector(".tableFrame");
  if (tableFrame)
    tableFrame.addEventListener("scroll", () => hideTip(), { passive: true });

  // Escape to close tooltip
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
}

// ---------- THEME ----------
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  themeToggleEl.checked = dark;

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

themeToggleEl.addEventListener("change", () =>
  applyTheme(themeToggleEl.checked),
);

// ---------- TABLE HEADER ----------
function buildTgHeader() {
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
      maxWidth: 420,
      minWidth: 280,
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
  const accent = cssVar("--accent", "#3b82f6"); // BLUE while talking
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
    radius = 12;
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
  const accent = cssVar("--accent", "#3b82f6"); // BLUE while talking
  marker.setStyle({
    color: accent,
    fillColor: accent,
    radius: 12,
    fillOpacity: 1.0,
    weight: 3,
    opacity: 1,
  });
  setTalkLabel(marker, node.callsign, true);
}

function visibleTalkersOutsideBelgium() {
  const showRepeaters = showRepeatersEl.checked;
  const showHotspots = showHotspotsEl.checked;
  const activeOnly = activeOnlyEl.checked;

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
  const showRepeaters = showRepeatersEl.checked;
  const showHotspots = showHotspotsEl.checked;
  const activeOnly = activeOnlyEl.checked;

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
      // Hotspots only visible while TALKING
      if (!showHotspots || !n.isTalker) {
        removeMarker(state.hsMarkers, n.callsign);
        continue;
      }

      const popup = popupHtmlForNode(n.callsign, loc);
      const m = upsertMarker(state.hsMarkers, n.callsign, lat, lon, popup);
      setHotspotStyle(m, { ...n, lat, lon });
    }
  }

  for (const cs of Array.from(state.repMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.repMarkers, cs);
  }
  for (const cs of Array.from(state.hsMarkers.keys())) {
    if (!state.nodes.has(cs)) removeMarker(state.hsMarkers, cs);
  }
}

// ---------- RENDER ----------
function renderStatus() {
  const online = Array.from(state.nodes.values()).filter(
    (n) => n.online,
  ).length;
  const offline = Array.from(state.nodes.values()).filter(
    (n) => !n.online,
  ).length;
  const talking = Array.from(state.nodes.values()).filter(
    (n) => n.isTalker,
  ).length;

  statusEl.textContent = state.wsOk
    ? `Connected • Online: ${online} • Offline: ${offline} • Talking: ${talking}`
    : "Disconnected • Reconnecting…";

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
  const showRepeaters = showRepeatersEl.checked;
  const showHotspots = showHotspotsEl.checked;
  const activeOnly = activeOnlyEl.checked;

  const rep = isRepeater(node.callsign);
  if (rep && !showRepeaters) return false;
  if (!rep && !showHotspots) return false;

  if (activeOnly && !node.online) return false;

  const windowSec = Number(windowSelectEl.value) || 3600;
  const windowMs = windowSec * 1000;

  if (node.isTalker) return true;

  const last = state.lastHeard.get(node.callsign) || 0;

  // If Active-only is OFF: show offline nodes even if last-heard unknown
  if (!activeOnly && !node.online && !last) return true;

  if (!last) return false;
  return nowMs - last <= windowMs;
}

function renderTable() {
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

  const ok = cssVar("--ok", "#35c48d");
  const bad = cssVar("--bad", "#ff6b6b");

  const html = rows
    .map(({ n, last }) => {
      const dot = n.online
        ? `<span class="dotOnline"></span>`
        : `<span class="dotOffline"></span>`; // red offline is defined in CSS

      const heard = n.isTalker
        ? `<span class="timeNow">Now</span>`
        : last
          ? msAgoLabel(Date.now() - last)
          : "—";

      const monitored = Array.isArray(n.monitoredTGs) ? n.monitoredTGs : [];
      const talkTg = chooseTalkTg(n);

      const tgCells = TG_LIST.map((tg) => {
        if (n.isTalker && talkTg === tg)
          return `<td class="tg"><span class="tgTalkDot"></span></td>`;
        if (monitored.includes(tg))
          return `<td class="tg"><span class="tgCheck">✓</span></td>`;
        return `<td class="tg"></td>`;
      }).join("");

      const trCls = n.isTalker ? "talkingRow" : "";
      const loc = formatLocation(n.location || "");

      return `
      <tr class="${trCls}">
        <td class="narrow center">${dot}</td>
        <td><span class="csHover" data-cs="${n.callsign}"><strong>${n.callsign}</strong></span></td>
        <td>${loc}</td>
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
  if (state.map) {
    updateMapMarkers();
    updateMapFocus();
  }
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

  if (!wasTalker && isTalker) {
    const t = Date.now();
    const old = state.lastHeard.get(cs) || 0;
    if (t > old) state.lastHeard.set(cs, t);
  }
  if (wasTalker && !isTalker) {
    const t = Date.now();
    const old = state.lastHeard.get(cs) || 0;
    if (t > old) state.lastHeard.set(cs, t);
  }

  state.prevTalker.set(cs, isTalker);
}

function connectWs() {
  const wsUrl = state.cfg.wsUrl;
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

  // config
  const cfgResp = await fetch("/config.json", { cache: "no-store" });
  state.cfg = await cfgResp.json();

  if (state.cfg.title) titleEl.textContent = state.cfg.title;

  // merge info maps (LOCAL_* overridden by env-config if you prefer)
  const tgMerged = { ...LOCAL_TG_INFO, ...(state.cfg.talkgroupInfo || {}) };
  const csMerged = {
    ...LOCAL_CALLSIGN_INFO,
    ...(state.cfg.callsignInfo || {}),
  };
  state.tgInfo = normalizeTgInfo(tgMerged);
  state.csInfo = normalizeCsInfo(csMerged);

  buildTgHeader();
  initHoverTooltips();

  [showRepeatersEl, showHotspotsEl, activeOnlyEl, windowSelectEl].forEach(
    (el) => {
      el.addEventListener("change", () => renderAll());
    },
  );

  // 1Hz refresh for "time since heard"
  setInterval(() => renderTable(), 1000);

  connectWs();
  renderAll();
}

main().catch(() => {
  statusEl.textContent = "Startup failed";
  statusEl.className = "conn bad";
});
