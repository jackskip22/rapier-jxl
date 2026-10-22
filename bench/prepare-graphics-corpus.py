#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fetch pinned public inputs and preserve their full-size RGBA pixels.

Requires Pillow (receipt uses 12.3.0). Local complete-corpus and authored inputs
are loaded directly by graphics-corpus.mjs and do not need this preparation.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request

from PIL import Image, __version__ as pillow_version

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--downloads', type=Path, help='reuse verified original image files from this directory')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
manifest = json.loads(Path(__file__).with_name('graphics-corpus-sources.json').read_text())
cached = {}
for entry in manifest:
    if 'url' not in entry:
        continue
    url = entry['url']
    if url not in cached:
        local = args.downloads / entry['sourceFile'] if args.downloads else None
        if local and local.is_file():
            encoded = local.read_bytes()
        else:
            request = urllib.request.Request(url, headers={'User-Agent': 'rapier-jxl-graphics-proof/1.0'})
            with urllib.request.urlopen(request, timeout=60) as response:
                encoded = response.read()
        assert hashlib.sha256(encoded).hexdigest() == entry['sourceSha256'], entry['id'] + ' original file hash'
        cached[url] = encoded
    image = Image.open(io.BytesIO(cached[url]))
    if 'frame' in entry:
        image.seek(entry['frame'])
    image = image.convert('RGBA')
    assert image.size == (entry['width'], entry['height']), entry['id'] + ' original dimensions'
    rgba = image.tobytes()
    assert hashlib.sha256(rgba).hexdigest() == entry['rgbaSha256'], entry['id'] + ' original pixel hash'
    (args.output / (entry['id'] + '.rgba')).write_bytes(rgba)
    print(entry['id'], image.size, len(rgba), entry['rgbaSha256'])
(args.output / 'preparation.json').write_text(json.dumps({'pillow': pillow_version,
    'operation': 'original frame seek, straight RGBA conversion; no resizing or color adjustment'}, indent=2) + '\n')
