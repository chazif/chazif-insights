#!/usr/bin/env python3
"""Zero-dependency dev server for verifying the Phase 0 seam locally.
Serves the frontend and resolves /api/bundle from data/clients/<client>/<period>/bundle.json.
Production uses backend/main.py (FastAPI) with the same routes.

Run:  py backend/dev_server.py   ->  http://localhost:8000
"""
import json, os, posixpath
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
DATA = os.path.join(ROOT, "data", "clients")
PORT = int(os.environ.get("PORT", "8000"))

CT = {".html": "text/html", ".js": "application/javascript", ".css": "text/css",
      ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/bundle":
            q = parse_qs(u.query)
            client = (q.get("client") or ["mavis"])[0]
            period = (q.get("period") or ["2026-03"])[0]
            # guard against path traversal
            if any(c in client + period for c in ("..", "/", "\\")):
                return self._send(400, json.dumps({"error": "bad client/period"}))
            path = os.path.join(DATA, client, period, "bundle.json")
            if not os.path.isfile(path):
                return self._send(404, json.dumps({"error": f"no bundle for {client}/{period}"}))
            with open(path, "rb") as f:
                return self._send(200, f.read(), "application/json")

        # static frontend
        rel = u.path.lstrip("/") or "index.html"
        safe = posixpath.normpath(rel)
        if safe.startswith("..") or os.path.isabs(safe):
            return self._send(403, "forbidden", "text/plain")
        path = os.path.join(FRONTEND, safe)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.isfile(path):
            return self._send(404, "not found", "text/plain")
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            return self._send(200, f.read(), CT.get(ext, "application/octet-stream"))

    def log_message(self, *a):
        pass  # quiet


if __name__ == "__main__":
    print(f"dev server on http://localhost:{PORT}  (frontend={FRONTEND})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
