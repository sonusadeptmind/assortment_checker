#!/bin/bash

# Always serve from the directory this script lives in,
# regardless of where it is launched from.
cd "$(dirname "$0")"

echo "──────────────────────────────────────────"
echo " Assortment QA Dashboard"
echo " Serving from: $(pwd)"
echo " URL: http://localhost:8000/assortment_checker.html"
echo " Press Ctrl+C to stop."
echo "──────────────────────────────────────────"

# Kill any existing server already on port 8000 to avoid stale-version issues.
existing=$(lsof -ti :8000 2>/dev/null)
if [ -n "$existing" ]; then
  echo "Stopping existing server on port 8000 (PID $existing)..."
  kill "$existing" 2>/dev/null
  sleep 0.5
fi

# Open the browser after a short delay to give the server time to start.
# Detect the platform and use the appropriate command.
open_browser() {
  local url="$1"
  case "$(uname -s)" in
    Darwin)  open "$url" ;;
    Linux*)  xdg-open "$url" 2>/dev/null || echo "Could not open browser. Visit $url manually." ;;
    MINGW*|MSYS*|CYGWIN*) start "$url" 2>/dev/null || echo "Could not open browser. Visit $url manually." ;;
    *)       echo "Could not detect OS. Visit $url manually." ;;
  esac
}
(sleep 1 && open_browser "http://localhost:8000/assortment_checker.html") &

# Start Python server with Cache-Control: no-cache headers so the browser
# always fetches the latest app.js and styles.css instead of using a cached copy.
python3 - <<'PYEOF'
import http.server
import json
import os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "http://localhost:8000")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        save_routes = {
            "/save_labels_store":    "labels_store.json",
            "/save_qa_metadata":     "qa_metadata.json",
            "/save_keyword_metrics": "keyword_metrics.json",
            "/save_iteration_history": "iteration_history.json",
        }
        if self.path in save_routes:
            filename = save_routes[self.path]
            try:
                length = int(self.headers.get("Content-Length", 0))
                body   = self.rfile.read(length)
                data   = json.loads(body)
                with open(filename, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "http://localhost:8000")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except Exception as exc:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(exc)}).encode())
        else:
            self.send_error(404)

http.server.test(HandlerClass=NoCacheHandler, port=8000)
PYEOF
