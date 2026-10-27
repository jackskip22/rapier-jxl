#!/usr/bin/env python3
"""Extract checksum-verified LZIP members without a system lzip dependency."""
import io
import lzma
from pathlib import Path
import struct
import sys
import tarfile
import zlib

remaining = Path(sys.argv[1]).read_bytes()
parts = []
while remaining:
    if remaining[:5] != b'LZIP\x01':
        raise ValueError('Unsupported LZIP member')
    coded = remaining[5]
    size = (1 << (coded & 31)) - ((1 << (coded & 31)) // 16) * (coded >> 5)
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_RAW,
                                  filters=[{'id': lzma.FILTER_LZMA1, 'dict_size': size, 'lc': 3, 'lp': 0, 'pb': 2}])
    data = decoder.decompress(remaining[6:])
    crc, length, member_size = struct.unpack('<IQQ', decoder.unused_data[:20])
    if len(data) != length or zlib.crc32(data) != crc or member_size != len(remaining) - len(decoder.unused_data) + 20:
        raise ValueError('Corrupt LZIP member')
    parts.append(data)
    remaining = decoder.unused_data[20:]
with tarfile.open(fileobj=io.BytesIO(b''.join(parts))) as archive:
    archive.extractall(sys.argv[2], filter='data')
