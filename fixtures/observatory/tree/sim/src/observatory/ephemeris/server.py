"""The service over HTTP: GET /where?body=Mars&at=2026-09-01T12:00:00Z."""

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from observatory.ephemeris.service import EphemerisService


class EphemerisHandler(BaseHTTPRequestHandler):
    """Answers /where from the service serve() sets."""

    service = None

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/where":
            self._send(404, {"error": f"no such page: {url.path}"})
            return
        query = parse_qs(url.query)
        body = query.get("body", [""])[0]
        if body not in self.service.bodies():
            self._send(400, {"error": f"unknown body: {body!r}"})
            return
        at = query.get("at", [""])[0]
        try:
            moment = datetime.fromisoformat(at) if at else datetime.now(timezone.utc)
        except ValueError:
            self._send(400, {"error": f"not a time: {at!r}"})
            return
        x, y, z = self.service.where(body, moment)
        self._send(200, {"body": body, "at": moment.isoformat(), "x": x, "y": y, "z": z})

    def _send(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        """Quieter than the default, which logs every request to stderr."""


def serve(port, service=None):
    """Serves on 127.0.0.1:port until interrupted."""
    EphemerisHandler.service = service or EphemerisService()
    with ThreadingHTTPServer(("127.0.0.1", port), EphemerisHandler) as httpd:
        httpd.serve_forever()
