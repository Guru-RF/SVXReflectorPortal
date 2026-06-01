/*
 * Live audio player for the SVX Reflector portal.
 *
 * A deliberately small companion to the map/table: it lets you LISTEN to one
 * talkgroup at a time. The portal itself already shows who is talking, so this
 * only does two things — switch talkgroup and play.
 *
 * - Talkgroups are discovered from the stream's `tg_list` message (no hard-coded
 *   list); whatever the svxlink-stream server exposes becomes a toggle button.
 * - Only one talkgroup plays at a time. Picking another switches to it; picking
 *   the active one again stops playback.
 *
 * Audio path mirrors the svxlink-stream web client: per-frame Opus is decoded
 * with WebCodecs where available, falling back to a WASM Opus decoder
 * (Safari/iOS), and played through a jitter-buffer AudioWorklet.
 */

const OPUS_WASM_CDN = "https://cdn.jsdelivr.net/npm/opus-decoder@0.7.7/+esm";
const FRAME_SR = 48000; // decoder output sample rate
const TARGET_MS = 150; // jitter buffer prebuffer

let cfg = null;
let ws = null;
let audioCtx = null;
let decoderKind = null; // 'webcodecs' | 'wasm'
let OpusDecoderClass = null; // lazily imported for the wasm path
let workletReady = false;

let availableTgs = []; // from tg_list
let activeTg = null; // the single tg we're currently playing (or null)
let channel = null; // live Channel for activeTg
let starting = false; // guards re-entrant button clicks while spinning up

let reconnectTimer = null;
let reconnectDelay = 1000;
let manualClose = false;

// DOM (created in init)
let wrapEl = null;
let btnsEl = null;

/* ---------- decoder capability detection ---------- */

async function detectDecoder() {
  if (window.AudioDecoder && AudioDecoder.isConfigSupported) {
    try {
      const s = await AudioDecoder.isConfigSupported({
        codec: "opus",
        sampleRate: FRAME_SR,
        numberOfChannels: 1,
      });
      if (s.supported) return "webcodecs";
    } catch (_) {
      /* fall through */
    }
  }
  return "wasm";
}

/* ---------- one talkgroup channel ---------- */

class Channel {
  constructor(tg) {
    this.tg = tg;
    this.ts = 0;
    this.gain = audioCtx.createGain();
    this.gain.connect(audioCtx.destination);
    this.node = new AudioWorkletNode(audioCtx, "jitter-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sampleRate: FRAME_SR, targetMs: TARGET_MS },
    });
    this.node.connect(this.gain);
  }

  async initDecoder() {
    if (decoderKind === "webcodecs") {
      this.decoder = new AudioDecoder({
        output: (audioData) => {
          const n = audioData.numberOfFrames;
          const pcm = new Float32Array(n);
          try {
            audioData.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
          } catch (_) {
            audioData.copyTo(pcm, { planeIndex: 0 });
          }
          this.node.port.postMessage({ pcm }, [pcm.buffer]);
          audioData.close();
        },
        error: (e) => console.warn(`TG ${this.tg} decode error`, e),
      });
      this.decoder.configure({
        codec: "opus",
        sampleRate: FRAME_SR,
        numberOfChannels: 1,
      });
    } else {
      this.wasm = new OpusDecoderClass({ channels: 1 });
      await this.wasm.ready;
    }
  }

  decode(opusBytes) {
    if (decoderKind === "webcodecs") {
      if (this.decoder.state !== "configured") return;
      this.decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: this.ts,
          data: opusBytes,
        }),
      );
      this.ts += 20000; // 20 ms in microseconds
    } else if (this.wasm) {
      const { channelData, samplesDecoded } = this.wasm.decodeFrame(opusBytes);
      if (samplesDecoded > 0) {
        const pcm = channelData[0].slice(0, samplesDecoded); // copy (decoder reuses its buffer)
        this.node.port.postMessage({ pcm }, [pcm.buffer]);
      }
    }
  }

  destroy() {
    try {
      this.node.port.postMessage({ flush: true });
    } catch (_) {}
    try {
      this.node.disconnect();
    } catch (_) {}
    try {
      this.gain.disconnect();
    } catch (_) {}
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch (_) {}
    }
    if (this.wasm) {
      try {
        this.wasm.free();
      } catch (_) {}
    }
  }
}

/* ---------- WebSocket ---------- */

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function streamWsUrl() {
  let base = String(cfg.streamWsUrl || "")
    .trim()
    .replace(/\/+$/, "");
  // Accept http(s):// or ws(s):// in config — WebSocket needs the ws(s) scheme.
  base = base.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  const tok = cfg.streamToken
    ? `?token=${encodeURIComponent(cfg.streamToken)}`
    : "";
  // Allow the configured value to already include the /ws path; otherwise add it.
  return /\/ws$/.test(base) ? `${base}${tok}` : `${base}/ws${tok}`;
}

function scheduleReconnect() {
  if (reconnectTimer || manualClose) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    connectWs();
  }, reconnectDelay);
}

function connectWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  let sock;
  try {
    sock = new WebSocket(streamWsUrl());
  } catch (_) {
    scheduleReconnect();
    return;
  }
  ws = sock;
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    reconnectDelay = 1000;
    // Re-subscribe if the user had picked a TG before a reconnect.
    if (activeTg != null) wsSend({ type: "subscribe", tgs: [activeTg] });
  };

  ws.onclose = () => {
    if (channel) channel.node.port.postMessage({ flush: true });
    if (ws === sock) ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {};

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.type === "tg_list") setTgList(msg.tgs || []);
      return;
    }
    const dv = new DataView(ev.data);
    if (dv.getUint8(0) !== 1) return; // 1 = audio
    const tg = dv.getUint32(1);
    if (tg !== activeTg || !channel) return; // only decode the chosen TG
    const opus = new Uint8Array(ev.data, 7);
    channel.decode(opus);
  };
}

/* ---------- playback control (single channel) ---------- */

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: FRAME_SR,
    });
  }
  if (!workletReady) {
    await audioCtx.audioWorklet.addModule("/audio-worklet.js");
    workletReady = true;
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

async function stop() {
  if (activeTg != null) wsSend({ type: "unsubscribe", tgs: [activeTg] });
  if (channel) {
    channel.destroy();
    channel = null;
  }
  activeTg = null;
  renderButtons();
}

async function play(tg) {
  if (starting) return;
  starting = true;
  try {
    // Switching away from a currently-playing TG: tear it down first.
    if (activeTg != null && activeTg !== tg) {
      wsSend({ type: "unsubscribe", tgs: [activeTg] });
      if (channel) {
        channel.destroy();
        channel = null;
      }
    }

    // Prepare decoder kind + (for Safari) the WASM Opus module, once.
    if (!decoderKind) decoderKind = await detectDecoder();
    if (decoderKind === "wasm" && !OpusDecoderClass) {
      ({ OpusDecoder: OpusDecoderClass } = await import(OPUS_WASM_CDN));
    }

    await ensureAudio();

    activeTg = tg;
    channel = new Channel(tg);
    await channel.initDecoder();

    if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
    wsSend({ type: "subscribe", tgs: [tg] });
  } catch (e) {
    console.warn("stream play failed", e);
    activeTg = null;
    if (channel) {
      channel.destroy();
      channel = null;
    }
  } finally {
    starting = false;
    renderButtons();
  }
}

function onPick(tg) {
  if (tg === activeTg) stop();
  else play(tg);
}

/* ---------- UI ---------- */

function setTgList(tgs) {
  // Keep numeric, de-duplicated, stable order.
  const seen = new Set();
  availableTgs = [];
  for (const t of tgs) {
    const n = Number(t);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      availableTgs.push(n);
    }
  }
  // If the active TG vanished from the list, stop it.
  if (activeTg != null && !seen.has(activeTg)) stop();
  renderButtons();
}

function tgLabel(tg) {
  // Friendly name from the portal's talkgroup info, if present.
  const info = cfg && cfg.talkgroupInfo ? cfg.talkgroupInfo[String(tg)] : null;
  if (info && typeof info === "string") {
    const first = info.split("\n")[0].trim();
    if (first) return first;
  }
  return null;
}

function renderButtons() {
  if (!btnsEl) return;
  btnsEl.innerHTML = "";

  if (!availableTgs.length) {
    const span = document.createElement("span");
    span.className = "streamHint";
    span.textContent = "connecting…";
    btnsEl.appendChild(span);
    return;
  }

  for (const tg of availableTgs) {
    const b = document.createElement("button");
    const isActive = tg === activeTg;
    b.type = "button";
    b.className = "streamBtn" + (isActive ? " active" : "");
    b.setAttribute("aria-pressed", isActive ? "true" : "false");
    const name = tgLabel(tg);
    if (name) b.title = name;
    b.innerHTML =
      `<span class="streamIco" aria-hidden="true">${isActive ? ICON_STOP : ICON_PLAY}</span>` +
      `<span class="streamTg">TG ${tg}</span>`;
    b.addEventListener("click", () => onPick(tg));
    btnsEl.appendChild(b);
  }
  // The player lives in the fixed header; its height feeds app.js's --headerH
  // (which sets the main content's top padding). Adding/wrapping buttons changes
  // that height, so ask app.js to re-measure.
  notifyHeaderResize();
}

// app.js recomputes the header height on window 'resize'. We grow the header by
// inserting the player row, so nudge it to re-measure (now and next frame, since
// layout/space metrics settle after paint).
function notifyHeaderResize() {
  try {
    window.dispatchEvent(new Event("resize"));
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  } catch (_) {}
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_STOP =
  '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function buildUi() {
  wrapEl = document.createElement("div");
  wrapEl.id = "streamPlayer";
  wrapEl.innerHTML = `
    <span class="streamLabel">
      <svg class="streamSpeaker" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12z"/>
      </svg>
      Listen
    </span>
    <span class="streamBtns" id="streamBtns"></span>
  `;
  btnsEl = wrapEl.querySelector("#streamBtns");

  // Place directly under the "Connected/Online…" status line. That status lives
  // in a header row (hidden on mobile), so anchor to the whole row and drop the
  // player on its own full-width line right after it.
  const status = document.getElementById("status");
  const header = document.querySelector("header");
  const statusRow = status ? status.closest(".row") : null;
  if (statusRow) statusRow.insertAdjacentElement("afterend", wrapEl);
  else if (status) status.insertAdjacentElement("afterend", wrapEl);
  else if (header) header.appendChild(wrapEl);
  else document.body.insertBefore(wrapEl, document.body.firstChild);

  // We just made the fixed header taller — have app.js re-measure --headerH so
  // the table/map below isn't hidden under the toolbar.
  notifyHeaderResize();
}

/* ---------- init ---------- */

async function init() {
  try {
    const r = await fetch("/config.json", { cache: "no-store" });
    cfg = await r.json();
  } catch (_) {
    return; // no config, no player
  }
  if (!cfg || !cfg.streamWsUrl) return; // streaming not enabled

  buildUi();
  renderButtons();
  connectWs(); // discover tg_list right away; audio starts on first click

  // Pause cleanly if the tab is closed.
  window.addEventListener("beforeunload", () => {
    manualClose = true;
    try {
      if (ws) ws.close();
    } catch (_) {}
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
