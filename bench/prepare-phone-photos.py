#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Verify/download original phone photos, including exact profiles and post-EOI tails.

Requires Pillow. No image is decoded and re-encoded or resized.
python3 prepare-phone-photos.py /tmp/phone24 --download
python3 prepare-phone-photos.py /tmp/phone24
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image


def sha(data):
    return hashlib.sha256(data).hexdigest()


def jpeg_parts(data):
    if data[:2] != b"\xff\xd8":
        raise ValueError("Not JPEG")
    at, entropy, parts, counts = 2, False, {}, set()
    while at < len(data):
        if entropy:
            at = data.find(b"\xff", at)
            if at < 0:
                break
        if data[at] != 255:
            raise ValueError("Invalid JPEG marker")
        while at < len(data) and data[at] == 255:
            at += 1
        if at == len(data):
            break
        marker = data[at]
        at += 1
        if entropy and (marker == 0 or 0xd0 <= marker <= 0xd7):
            continue
        entropy = False
        if marker == 0xd9:
            if parts and (len(counts) != 1 or sorted(parts) != list(range(1, next(iter(counts)) + 1))):
                raise ValueError("Incomplete ICC chunks")
            profile = b"".join(parts[i] for i in sorted(parts)) if parts else None
            tail = data[at:]
            return profile, {"primaryEOI": at, "tailBytes": len(tail),
                             "tailSha256": sha(tail) if tail else None,
                             "tailContainsJPEGSOI": b"\xff\xd8" in tail}
        if marker == 1 or 0xd0 <= marker <= 0xd7:
            continue
        if at + 2 > len(data):
            break
        length = struct.unpack_from(">H", data, at)[0]
        if length < 2 or at + length > len(data):
            raise ValueError("Invalid JPEG segment length")
        payload = data[at + 2:at + length]
        if marker == 0xe2 and payload.startswith(b"ICC_PROFILE\0"):
            if len(payload) < 14 or not payload[12] or not payload[13] or payload[12] in parts:
                raise ValueError("Invalid ICC chunk sequence")
            parts[payload[12]] = payload[14:]
            counts.add(payload[13])
        at += length
        entropy = marker == 0xda
    raise ValueError("Missing JPEG EOI")


def verify(data, row):
    if len(data) != row["bytes"] or sha(data) != row["sha256"]:
        raise ValueError("Original bytes do not match the pinned length/SHA-256")
    if hashlib.sha1(data).hexdigest() != row["commonsSha1"]:
        raise ValueError("Original bytes do not match Commons SHA-1")
    with Image.open(BytesIO(data)) as image:
        width, height = image.size
        exif = image.getexif()
        orientation = exif.get(274, 1)
        camera = {"make": exif.get(271), "model": exif.get(272), "software": exif.get(305),
                  "dateTimeOriginal": exif.get_ifd(0x8769).get(36867)}
        if any(camera[key] != row[key] for key in camera):
            raise ValueError("Camera metadata or capture date differ from the pin")
        display = [height, width] if orientation in (5, 6, 7, 8) else [width, height]
        if [width, height, orientation] != [row["width"], row["height"], row["orientation"]]:
            raise ValueError("JPEG dimensions or EXIF orientation differ from the pin")
        if display != [row["displayWidth"], row["displayHeight"]]:
            raise ValueError("Displayed dimensions differ from the pin")
    with Image.open(BytesIO(data)) as image:
        image.verify()
    profile, jpeg = jpeg_parts(data)
    if (sha(profile) if profile else None) != row["iccSha256"]:
        raise ValueError("ICC bytes differ from the pin")
    if jpeg != row["jpeg"]:
        raise ValueError("JPEG post-EOI tail differs from the pin")
    icc = None
    if profile:
        declared = struct.unpack_from(">I", profile)[0]
        padding = profile[declared:] if declared <= len(profile) else None
        icc = {"bytes": len(profile), "sha256": sha(profile), "declaredBytes": declared,
               "trailingBytes": len(padding) if padding is not None else None,
               "trailingAllZero": not any(padding) if padding is not None else None}
    return {"id": row["id"], "file": row["file"], "bytes": len(data), "sha256": sha(data),
            "width": width, "height": height, "orientation": orientation,
            "displayDimensions": display, "camera": camera, "icc": icc, "jpeg": jpeg}


def download(row):
    url = urllib.parse.urlsplit(row["originalURL"])
    if url.scheme != "https" or url.hostname != "upload.wikimedia.org" or "/thumb/" in url.path:
        raise ValueError("Expected an original HTTPS Commons upload")
    for attempt in range(5):
        try:
            request = urllib.request.Request(row["originalURL"], headers={"User-Agent": "rapier-jxl-bench/1.0 (https://rapier.website)"})
            with urllib.request.urlopen(request, timeout=45) as response:
                final = urllib.parse.urlsplit(response.url)
                if final.scheme != "https" or final.hostname != "upload.wikimedia.org" or "/thumb/" in final.path:
                    raise ValueError("Original download redirected outside its expected source")
                return response.read(row["bytes"] + 1)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 4:
                raise
            retry = error.headers.get("Retry-After", "")
            delay = min(45, max(2 * (attempt + 1), int(retry) if retry.isdigit() else 0))
            print(json.dumps({"id": row["id"], "retry": attempt + 1, "http": error.code, "delaySeconds": delay}), flush=True)
            time.sleep(delay)


def acquire(row, args):
    result = {"id": row["id"], "status": "FAIL"}
    try:
        if not re.fullmatch(r"[a-z0-9-]+\.jpg", row["file"]):
            raise ValueError("Invalid corpus filename")
        path = args.output / row["file"]
        if path.is_symlink():
            raise ValueError("Corpus files must not be symbolic links")
        present = path.exists()
        if not present and not args.download:
            raise FileNotFoundError(str(path) + "; use --download to fetch the pinned original")
        data = path.read_bytes() if present else download(row)
        result = verify(data, row)
        if not present:
            temporary = path.with_suffix(".jpg.part")
            if temporary.is_symlink():
                raise ValueError("Temporary path must not be a symbolic link")
            temporary.write_bytes(data)
            os.replace(temporary, path)
        result.update({"status": "PASS", "source": "existing-local" if present else "original-download"})
    except Exception as error:
        result.update({"status": "FAIL", "error": type(error).__name__ + ": " + str(error)})
    print(json.dumps({key: result[key] for key in ("id", "status", "bytes", "error") if key in result}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sources", type=Path, default=Path(__file__).with_name("phone-photos-sources.json"))
    parser.add_argument("--download", action="store_true", help="Fetch missing originals; a mismatching existing file is refused")
    parser.add_argument("--workers", type=int, default=3, choices=range(1, 5))
    parser.add_argument("--ids", help="Optional comma-separated IDs; all 24 are checked by default")
    args = parser.parse_args()
    manifest = json.loads(args.sources.read_text())
    rows = manifest["rows"]
    if len({row["id"] for row in rows}) != len(rows) or len({row["file"] for row in rows}) != len(rows):
        raise ValueError("Duplicate corpus IDs or filenames")
    if args.ids:
        ids = set(args.ids.split(","))
        rows = [row for row in rows if row["id"] in ids]
        if {row["id"] for row in rows} != ids:
            raise ValueError("Unknown corpus ID")
    args.output.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(acquire, row, args) for row in rows]
        results = sorted((future.result() for future in as_completed(futures)), key=lambda r: r["id"])
    passed = sum(row["status"] == "PASS" for row in results)
    receipt = {"sourcesSha256": sha(args.sources.read_bytes()), "scriptSha256": sha(Path(__file__).read_bytes()),
               "scope": "Exact original bytes, image dimensions/orientation, ICC bytes and post-EOI tails; no compression measurements",
               "planned": len(rows), "passed": passed, "failed": len(rows) - passed, "rows": results}
    (args.output / "custody.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: receipt[key] for key in ("planned", "passed", "failed")}), flush=True)
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
