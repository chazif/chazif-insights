#!/usr/bin/env python3
"""Split a single-file Chazif dashboard export into the app's 3-part layout:
    frontend/index.html  (shell + styles + markup + bundle loader)
    frontend/app.js       (view/render code; reads the global DATA bundle)
    data/clients/<client>/<period>/bundle.json  (the externalized DATA object)

The source single-file dashboards embed `const DATA = {...}` (strict JSON) plus
all the app JS in one <script>. This tool separates them so the frontend fetches
the bundle at runtime instead of inlining it.

Usage:
    py tools/split_dashboard.py --src "path\\to\\Dashboard.html" --client mavis --period 2026-03
"""
import argparse, json, os, re


def split(src, repo, client, period):
    with open(src, encoding="utf-8") as f:
        html = f.read()

    # find the app <script> (no src=, contains a DATA = { assignment)
    app = None
    for m in re.finditer(r"<script\b([^>]*)>", html, re.I):
        if "src=" in m.group(1).lower():
            continue
        bstart = m.end()
        bend = html.find("</script>", bstart)
        if re.search(r"DATA\s*=\s*\{", html[bstart:bend]):
            app = (m.start(), bstart, bend, bend + len("</script>"))
            break
    if not app:
        raise SystemExit("no app <script> with a DATA assignment found")
    tag_start, bstart, bend, close_end = app
    body = html[bstart:bend]

    # brace-match the DATA literal (string/escape aware)
    dm = re.search(r"DATA\s*=\s*\{", body)
    b0 = body.index("{", dm.start())
    i, depth, in_str, esc, end = b0, 0, False, False, None
    while i < len(body):
        c = body[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: end = i + 1; break
        i += 1
    if end is None:
        raise SystemExit("could not brace-match the DATA literal")

    data = json.loads(body[b0:end])  # validate strict JSON

    pre = re.sub(r"(?:\b(?:const|let|var)\b|window\.)\s*$", "", body[:dm.start()])
    rest = body[end:].lstrip()
    if rest.startswith(";"): rest = rest[1:]
    app_js = ("// Auto-split from a single-file dashboard export. Data arrives via the bundle loader.\n"
              "const DATA = window.__BUNDLE__;\n" + pre + rest)

    loader = (
        '<script>\n'
        '(function () {\n'
        '  var p = new URLSearchParams(location.search);\n'
        '  var client = p.get("client") || "%s";\n'
        '  var period = p.get("period") || "%s";\n'
        '  var url = window.BUNDLE_URL || ("/api/bundle?client=" + encodeURIComponent(client) + "&period=" + encodeURIComponent(period));\n'
        '  fetch(url)\n'
        '    .then(function (r) { if (!r.ok) throw new Error("bundle HTTP " + r.status); return r.json(); })\n'
        '    .then(function (d) {\n'
        '      window.__BUNDLE__ = d;\n'
        '      var s = document.createElement("script"); s.src = "app.js"; document.body.appendChild(s);\n'
        '    })\n'
        '    .catch(function (e) {\n'
        '      document.body.insertAdjacentHTML("beforeend",\n'
        '        "<pre style=\\"padding:24px;font-family:ui-monospace,monospace;color:#b00\\">Could not load data bundle: " + e.message + "</pre>");\n'
        '    });\n'
        '})();\n'
        '</script>'
    ) % (client, period)

    index_html = html[:tag_start] + loader + html[close_end:]

    fe = os.path.join(repo, "frontend")
    dd = os.path.join(repo, "data", "clients", client, period)
    os.makedirs(fe, exist_ok=True); os.makedirs(dd, exist_ok=True)
    with open(os.path.join(dd, "bundle.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(fe, "app.js"), "w", encoding="utf-8") as f:
        f.write(app_js)
    with open(os.path.join(fe, "index.html"), "w", encoding="utf-8") as f:
        f.write(index_html)
    print(f"bundle.json: {len(data)} keys | app.js: {len(app_js):,} chars | index.html: {len(index_html):,} chars")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="single-file dashboard .html")
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--client", default="mavis")
    ap.add_argument("--period", default="2026-03")
    a = ap.parse_args()
    split(a.src, a.repo, a.client, a.period)
