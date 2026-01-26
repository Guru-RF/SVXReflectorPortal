#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
from typing import Any, Dict, List, Optional

import websockets


def jdump(x: Any) -> str:
    return json.dumps(x, indent=2, ensure_ascii=False, sort_keys=True)


def find_node(snapshot: Dict[str, Any], callsign: str) -> Optional[Dict[str, Any]]:
    callsign = callsign.upper()
    nodes = snapshot.get("nodes") or []
    if not isinstance(nodes, list):
        return None
    for n in nodes:
        if isinstance(n, dict) and str(n.get("callsign", "")).upper() == callsign:
            return n
    return None


def find_sessions(snapshot: Dict[str, Any], callsign: str) -> List[Dict[str, Any]]:
    callsign = callsign.upper()
    out: List[Dict[str, Any]] = []
    for key in ("active", "sessions"):
        arr = snapshot.get(key) or []
        if not isinstance(arr, list):
            continue
        for s in arr:
            if not isinstance(s, dict):
                continue
            if str(s.get("callsign", "")).upper() == callsign:
                out.append(s)
    # newest first if possible
    def score(s: Dict[str, Any]) -> int:
        for k in ("start_ms", "end_ms"):
            v = s.get(k)
            try:
                return int(v or 0)
            except Exception:
                pass
        return 0

    out.sort(key=score, reverse=True)
    return out


async def get_snapshot(ws, timeout_s: float = 10.0) -> Dict[str, Any]:
    """
    Server should send snapshot immediately.
    If not, request one.
    """
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout_s)
    msg = json.loads(raw)
    if msg.get("type") == "snapshot":
        return msg

    # Ask explicitly
    try:
        await ws.send("snapshot")
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout_s)
        msg = json.loads(raw)
        if msg.get("type") == "snapshot":
            return msg
    except Exception:
        pass

    raise RuntimeError(f"Did not receive snapshot; first message was type={msg.get('type')!r}")


async def main() -> None:
    ap = argparse.ArgumentParser(description="Debug SVX node via WSS only (snapshot + live updates)")
    ap.add_argument("callsign", help="e.g. OO0O")
    ap.add_argument(
        "--ws",
        default=os.getenv("SVX_WS_URL", "wss://feed.example.org/ws"),
        help="WebSocket URL (default: wss://feed.example.org/ws)",
    )
    ap.add_argument("--watch", action="store_true", help="Print live updates for this callsign")
    ap.add_argument("--timeout", type=float, default=10.0, help="Handshake/recv timeout seconds")
    args = ap.parse_args()

    cs = args.callsign.upper()
    ws_url = args.ws

    print(f"Connecting: {ws_url}")
    async with websockets.connect(
        ws_url,
        open_timeout=args.timeout,
        ping_interval=20,
        ping_timeout=20,
        max_size=2_000_000,
    ) as ws:
        snap = await get_snapshot(ws, timeout_s=args.timeout)

        print("\n=== SNAPSHOT: node entry ===")
        node = find_node(snap, cs)
        if node is None:
            print(f"Node {cs} NOT FOUND in snapshot.nodes")
        else:
            print(jdump(node))

        print("\n=== SNAPSHOT: sessions mentioning this callsign (active + history) ===")
        sess = find_sessions(snap, cs)
        if not sess:
            print(f"No sessions found for {cs} in snapshot.active/snapshot.sessions")
        else:
            # Print up to 5 newest
            for i, s in enumerate(sess[:5], 1):
                print(f"\n--- session {i} ---")
                print(jdump(s))

        # Helpful hints (common cause)
        if node is None and sess:
            print(
                "\nNOTE: Callsign exists only in sessions but not in nodes list.\n"
                "This often means the backend filtered the node from /status (e.g. hidden:true),\n"
                "so the UI only knows it from session summaries (which may not include location/monitoredTGs)."
            )

        if not args.watch:
            print("\nDone. Use --watch to follow live WS events for this callsign.")
            return

        print("\n=== WATCH MODE (Ctrl+C to stop) ===")
        while True:
            raw = await ws.recv()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            t = msg.get("type")
            if t == "node_upsert":
                n = msg.get("node") or {}
                if str(n.get("callsign", "")).upper() == cs:
                    print("\n[node_upsert]")
                    print(jdump(n))

            elif t in ("talk_start", "talk_stop"):
                s = msg.get("session") or {}
                if str(s.get("callsign", "")).upper() == cs:
                    print(f"\n[{t}]")
                    print(jdump(s))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
