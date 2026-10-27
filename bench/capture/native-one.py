#!/usr/bin/env python3
"""One native benchmark process; reports wait4-style child peak RSS on Linux."""
import json
import resource
import subprocess
import sys
import time

start = time.perf_counter()
result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
elapsed = (time.perf_counter() - start) * 1000
print(json.dumps({"status": result.returncode, "ms": elapsed,
                  "peakRSSKiB": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                  "stdout": result.stdout.decode("utf8", errors="replace"),
                  "stderr": result.stderr.decode("utf8", errors="replace")}))
