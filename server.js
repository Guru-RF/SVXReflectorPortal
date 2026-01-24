const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// WebSocket endpoint of your reflector (public)
const UPSTREAM_WS_URL =
  process.env.UPSTREAM_WS_URL || "wss://feed.example.org/";

// Optional: show a different title in the header
const UI_TITLE = process.env.UI_TITLE || "SVX Reflector • Live";

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/config.json", (_req, res) => {
  res.set("cache-control", "no-store");
  res.json({
    wsUrl: UPSTREAM_WS_URL,
    title: UI_TITLE,
  });
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
