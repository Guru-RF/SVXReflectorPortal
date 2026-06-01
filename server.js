const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

const UPSTREAM_WS_URL =
  process.env.UPSTREAM_WS_URL || "wss://feed.example.org/";

const UI_TITLE = process.env.UI_TITLE || "SVX Reflector • Live";

// Optional live audio streaming (svxlink-stream). When STREAM_WS_URL is set the
// UI shows a small player under the status line that lets you listen to one
// talkgroup at a time. The talkgroup list is discovered from the stream itself.
const STREAM_WS_URL = process.env.STREAM_WS_URL || "";
const STREAM_TOKEN = process.env.STREAM_TOKEN || "";

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    console.warn(`Invalid JSON in ${name}: ${e.message}`);
    return {};
  }
}

// Optional metadata you can set without rebuilding:
const TALKGROUP_INFO = parseJsonEnv("TG_INFO_JSON"); // {"8":"...","1745":"..."}
const CALLSIGN_INFO = parseJsonEnv("CALLSIGN_INFO_JSON"); // {"ON0APS":"...","ON0BRK":"..."}

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/config.json", (_req, res) => {
  res.set("cache-control", "no-store");
  res.json({
    wsUrl: UPSTREAM_WS_URL,
    title: UI_TITLE,
    talkgroupInfo: TALKGROUP_INFO,
    callsignInfo: CALLSIGN_INFO,
    streamWsUrl: STREAM_WS_URL,
    streamToken: STREAM_TOKEN,
  });
});

app.get("/talkgroups.json", (_req, res) => {
  res.set("cache-control", "no-store");
  res.json(TALKGROUP_INFO);
});

app.get("/callsigns.json", (_req, res) => {
  res.set("cache-control", "no-store");
  res.json(CALLSIGN_INFO);
});

app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    maxAge: 0,
  }),
);

app.listen(PORT, () => {
  console.log(`UI listening on :${PORT}`);
  console.log(`UPSTREAM_WS_URL=${UPSTREAM_WS_URL}`);
});
