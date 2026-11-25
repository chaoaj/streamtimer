#!/usr/bin/env python3
"""Refresh the built-in copies of shows.json and rates.json inside index.html.

Stream Timer loads shows.json and rates.json from its own folder. When it can't
(for example, index.html opened straight from disk), it falls back to copies
embedded in index.html. Run this after editing either JSON file:

    python tools/build.py
"""
import json, os, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

def compact(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        data = json.load(f)                      # also checks the JSON is valid
    return json.dumps(data, separators=(',', ':'), ensure_ascii=False).replace('<', '\\u003c')

def fill(html, tag_id, payload):
    pat = re.compile(r'(<script type="application/json" id="%s">\n).*?(\n</script>)' % tag_id, re.S)
    if not pat.search(html):
        raise SystemExit(f'index.html has no <script id="{tag_id}"> block')
    return pat.sub(lambda m: m.group(1) + payload + m.group(2), html, count=1)

path = os.path.join(ROOT, 'index.html')
with open(path, encoding='utf-8') as f:
    html = f.read()
html = fill(html, 'fallbackData', compact('shows.json'))
html = fill(html, 'fallbackRates', compact('rates.json'))
with open(path, 'w', encoding='utf-8') as f:
    f.write(html)
print('Updated the built-in copies of shows.json and rates.json in index.html')
