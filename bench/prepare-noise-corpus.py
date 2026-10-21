#!/usr/bin/env python3
"""Download the two licensed grain examples and reproduce their pinned RGBA8 pixels."""
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.request

from PIL import Image, __version__ as pillow_version


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "noise-corpus")
    target.mkdir(parents=True, exist_ok=True)
    sources = json.loads(Path(__file__).with_name("noise-corpus-sources.json").read_text())
    for source in sources:
        original = target / (source["id"] + ".jpg")
        if original.exists():
            jpeg = original.read_bytes()
        else:
            request = urllib.request.Request(source["url"], headers={"User-Agent": "rapier-jxl-format-proof/1.0"})
            with urllib.request.urlopen(request) as response:
                jpeg = response.read()
        if digest(jpeg) != source["sourceSha256"]:
            raise ValueError(source["id"] + ": original JPEG hash differs")
        image = Image.open(io.BytesIO(jpeg)).convert("RGBA")
        if image.size != (source["width"], source["height"]):
            raise ValueError(source["id"] + ": dimensions differ")
        rgba = image.tobytes()
        if digest(rgba) != source["rgbaSha256"]:
            raise ValueError(source["id"] + ": decoded pixels differ; the receipt used Pillow 12.3.0")
        original.write_bytes(jpeg)
        (target / (source["id"] + ".rgba")).write_bytes(rgba)
        image.save(target / (source["id"] + ".png"))
        print(source["id"], len(jpeg), len(rgba), "Pillow", pillow_version)
    (target / "manifest.json").write_text(json.dumps(sources, indent=2) + "\n")


if __name__ == "__main__":
    main()
