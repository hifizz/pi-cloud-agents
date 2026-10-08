#!/usr/bin/env python3
"""GUI benchmark site (Task 15). Serves l1/l2/l3 on 127.0.0.1:8765 inside the Space.

Per-run secrets live in STATE (state.json, written by scripts/gui-bench.mjs before each run):
  {"l1_token": "...", "l2_user": "...", "l2_pass": "...", "l2_token": "...", "l3_order": "..."}
Submissions and login attempts are appended to EVENTS (events.jsonl) so the harness can verify server-side.
The site never exposes STATE or EVENTS over HTTP.
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("BENCH_STATE", os.path.join(ROOT, "state.json"))
EVENTS = os.environ.get("BENCH_EVENTS", os.path.join(ROOT, "events.jsonl"))

PRODUCTS = [
    ("p01", "USB-C Cable 1m Black"),
    ("p02", "USB-C Cable 2m Black"),
    ("p03", "USB-C Cable 2m White"),
    ("p04", "HDMI Cable 2m"),
    ("p05", "Wireless Mouse Graphite"),
    ("p06", "Wireless Mouse Silver"),
    ("p07", "Mechanical Keyboard Blue Switch"),
    ("p08", "Mechanical Keyboard Red Switch"),
    ("p09", "Laptop Stand Aluminium"),
    ("p10", "Webcam 1080p"),
    ("p11", "Desk Lamp LED"),
    ("p12", "Monitor Arm Single"),
]


def state():
    with open(STATE) as f:
        return json.load(f)


def log_event(ev):
    ev["t"] = time.time()
    with open(EVENTS, "a") as f:
        f.write(json.dumps(ev) + "\n")


def page(title, body, script=""):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font:18px sans-serif;margin:40px;max-width:720px}}input,button{{font-size:18px;padding:6px;margin:4px 0}}
label{{display:block;margin:6px 0}}.code{{font:bold 28px monospace;background:#eef;padding:8px;display:inline-block}}</style>
</head><body>{body}<script>{script}</script></body></html>""".encode()


L3_SCRIPT = """
const q = document.getElementById('q');
function f() {
  const v = q.value.trim().toLowerCase();
  document.querySelectorAll('#items label').forEach(l => {
    l.style.display = l.textContent.toLowerCase().includes(v) ? '' : 'none';
  });
}
q.addEventListener('input', f);
"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        s = state()
        if path == "/l1.html":
            return self.send(200, page("Welcome", f"<h1>Welcome</h1><p>Your access code is:</p><p class='code'>{s['l1_token']}</p>"))
        if path == "/l2.html":
            return self.send(200, page("Sign in", """<h1>Sign in</h1>
<form method="post" action="/l2/login">
<label>Username <input name="user" autocomplete="off"></label>
<label>Password <input name="pass" type="password" autocomplete="off"></label>
<button type="submit">Log in</button></form>"""))
        if path == "/l3.html":
            items = "".join(
                f'<label><input type="checkbox" name="item" value="{pid}"> {name}</label>' for pid, name in PRODUCTS
            )
            return self.send(
                200,
                page(
                    "Shop",
                    f"""<h1>Office Shop</h1>
<label>Search <input id="q" placeholder="type to filter" autocomplete="off"></label>
<form method="post" action="/l3/submit"><div id="items">{items}</div>
<button type="submit">Submit order</button></form>""",
                    L3_SCRIPT,
                ),
            )
        if path == "/":
            return self.send(200, page("Bench", "<p>bench site</p>"))
        return self.send(404, page("Not found", "<h1>404</h1>"))

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        form = parse_qs(self.rfile.read(n).decode())
        path = urlparse(self.path).path
        s = state()
        if path == "/l2/login":
            user = form.get("user", [""])[0]
            pw = form.get("pass", [""])[0]
            ok = user == s["l2_user"] and pw == s["l2_pass"]
            log_event({"kind": "login", "ok": ok, "user": user})
            if ok:
                return self.send(200, page("Signed in", f"<h1>Signed in</h1><p>Your confirmation code is:</p><p class='code'>{s['l2_token']}</p>"))
            return self.send(401, page("Sign in failed", "<h1>Sign in failed</h1><p>Invalid username or password.</p><p><a href='/l2.html'>Try again</a></p>"))
        if path == "/l3/submit":
            items = sorted(form.get("item", []))
            log_event({"kind": "order", "items": items})
            if not items:
                return self.send(400, page("Empty order", "<h1>Nothing selected</h1><p><a href='/l3.html'>Back</a></p>"))
            names = ", ".join(dict(PRODUCTS)[i] for i in items if i in dict(PRODUCTS))
            return self.send(200, page("Order placed", f"<h1>Order placed</h1><p>Items: {names}</p><p>Order number:</p><p class='code'>{s['l3_order']}</p>"))
        return self.send(404, page("Not found", "<h1>404</h1>"))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    HTTPServer(("127.0.0.1", port), H).serve_forever()
