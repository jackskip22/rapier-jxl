# Rapier and libjxl: benchmark and conformance results

## Environment

- Run label: tip, merged from full-quick-tip, libjxl-all, table, lossy, ab; started 2026-10-09T10:00:17.253Z.
- Host: Intel(R) Xeon(R) Processor @ 2.30GHz, 4 logical CPUs, linux/x64 6.18.44-fc-v80; Node v22.23.3; CPU affinity 2.
- Tools: cjxl v0.12.0 4128790 [_AVX2_,SSE4,SSE2] {Clang 18.1.3}; djxl v0.12.0 4128790 [_AVX2_,SSE4,SSE2] {Clang 18.1.3}; jxl-oxide-cli 0.12.6.
- Timing: One process, one calling thread, sequential. Rapier is timed in-process through the complete encoder (createEncoder); libjxl through a persistent helper that creates a fresh single-threaded encoder per call. Encode time excludes input loading and decoding. The first run is a cold call and is recorded separately; warmup runs follow until the engine has compiled the hot loops (about two seconds of runs, at most 25), then timing; the number of timed runs shrinks as a run gets longer so that every setting takes about the budget.

## Conformance

Rapier outputs decoded with both djxl and jxl-oxide: 302 of 302. Lossless outputs compared with the source RGBA, including colour under zero alpha: 284 exact of 284.

No failures.

Lossy outputs: the two decoders differ by at most 1 level(s) across 18 streams.

## Lossless: Rapier against libjxl by group and effort

218 of 586 timed settings ran while the machine's one-minute load average was above the limit set for the run; their absolute times are unreliable, but Rapier and libjxl alternated within each setting, so their ratio is comparable.

Bytes are totals over the images of a group. Time covers the images that were timed: the total of per-image medians (CPU ms), and the geometric mean over those images of Rapier time divided by libjxl time. A size ratio below 1 means Rapier is smaller.

| Group | Effort | Images | Rapier bytes | libjxl bytes | Size ratio | Rapier smaller | Timed images | Rapier ms | libjxl ms | Time ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| kodak | 1 | 24 | 12,348,760 | 12,888,190 | 0.9581 | 24 | 4 | 228 | 11 | 20.4 |
| kodak | 3 | 24 | 11,893,795 | 11,133,923 | 1.0682 | 0 | 4 | 1,032 | 306 | 3.4 |
| kodak | 7 | 24 | 10,894,542 | 10,131,836 | 1.0753 | 0 | 4 | 11,572 | 2,590 | 4.5 |
| kodak | 9 | 24 | 10,373,202 | 10,008,326 | 1.0365 | 0 | 4 | 61,863 | 12,858 | 4.8 |
| large | 1 | 5 | 11,569,782 | 12,035,003 | 0.9613 | 5 | 2 | 163 | 8 | 19.6 |
| large | 3 | 5 | 11,020,776 | 10,332,651 | 1.0666 | 0 | 2 | 649 | 233 | 2.8 |
| large | 7 | 5 | 10,296,429 | 9,898,636 | 1.0402 | 0 | 2 | 7,151 | 1,700 | 4.2 |
| large | 9 | 5 | 9,871,655 | 9,788,906 | 1.0085 | 2 | 2 | 36,362 | 10,021 | 3.6 |
| rapier | 1 | 5 | 528,308 | 608,550 | 0.8681 | 5 | 5 | 256 | 7 | 32.5 |
| rapier | 3 | 5 | 468,258 | 497,073 | 0.9420 | 3 | 5 | 1,064 | 214 | 5.0 |
| rapier | 7 | 5 | 420,005 | 404,609 | 1.0381 | 3 | 5 | 7,869 | 1,039 | 9.9 |
| rapier | 9 | 5 | 399,354 | 395,682 | 1.0093 | 4 | 5 | 42,382 | 4,411 | 12.9 |
| ui | 1 | 12 | 1,310,304 | 1,602,276 | 0.8178 | 11 | 4 | 328 | 9 | 35.1 |
| ui | 3 | 12 | 1,217,732 | 1,412,665 | 0.8620 | 6 | 4 | 1,422 | 565 | 2.5 |
| ui | 7 | 12 | 899,974 | 958,587 | 0.9389 | 5 | 4 | 10,127 | 1,279 | 8.3 |
| ui | 9 | 12 | 791,105 | 807,376 | 0.9798 | 6 | 4 | 51,044 | 8,435 | 7.2 |
| pixel | 1 | 9 | 162,325 | 184,434 | 0.8801 | 9 | 4 | 200 | 5 | 35.4 |
| pixel | 3 | 9 | 160,237 | 227,179 | 0.7053 | 7 | 4 | 670 | 66 | 15.6 |
| pixel | 7 | 9 | 145,458 | 120,556 | 1.2066 | 3 | 4 | 4,304 | 221 | 34.4 |
| pixel | 9 | 9 | 137,086 | 110,789 | 1.2374 | 2 | 4 | 23,755 | 969 | 40.1 |
| icons | 1 | 8 | 100,423 | 154,191 | 0.6513 | 8 | 3 | 64 | 2 | 29.7 |
| icons | 3 | 8 | 97,685 | 113,256 | 0.8625 | 7 | 3 | 351 | 15 | 23.1 |
| icons | 7 | 8 | 75,136 | 65,072 | 1.1547 | 3 | 3 | 2,110 | 57 | 41.1 |
| icons | 9 | 8 | 73,111 | 58,891 | 1.2415 | 2 | 3 | 9,005 | 318 | 32.1 |
| alpha | 1 | 8 | 1,945,455 | 2,092,110 | 0.9299 | 8 | 3 | 162 | 8 | 20.3 |
| alpha | 3 | 8 | 1,859,019 | 1,770,748 | 1.0498 | 3 | 3 | 722 | 382 | 2.3 |
| alpha | 7 | 8 | 1,674,829 | 1,569,997 | 1.0668 | 1 | 3 | 8,164 | 1,310 | 6.4 |
| alpha | 9 | 8 | 1,557,420 | 1,530,034 | 1.0179 | 3 | 3 | 44,966 | 6,151 | 7.7 |

## Lossy: Rapier photo path against libjxl

Opaque images only (scores are not computed when alpha is present). `ssim2` is ssimulacra2 (higher is better), `ba` is the butteraugli distance (lower is better), both measured on djxl output. libjxl at d is its distance for the same quality number at effort 7; "matched" is the libjxl effort 7 distance whose size is within 1% of Rapier's (or the closest found). Images whose lossy attempt returned the exact result are left out.

| Group | Q | Images | Rapier bytes | ssim2 | ba | ms | libjxl d bytes | ssim2 | ba | ms | libjxl matched bytes | ssim2 | ba |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| kodak | 90 | 3 | 259,253 | 77.98 | 2.80 | 3,500 | 321,455 | 86.46 | 1.34 | 667 | 260,308 | 82.51 | 1.83 |
| kodak | 75 | 3 | 150,072 | 59.16 | 4.94 | 2,851 | 175,678 | 73.38 | 2.73 | 577 | 149,963 | 68.64 | 3.28 |
| kodak | 50 | 3 | 90,433 | 36.44 | 7.95 | 2,338 | 97,763 | 55.13 | 4.46 | 606 | 90,244 | 52.09 | 4.67 |
| rapier | 90 | 1 | 55,400 | 83.47 | 1.75 | 1,161 | 58,123 | 84.73 | 1.18 | 178 | 55,242 | 82.80 | 1.40 |
| rapier | 75 | 1 | 31,453 | 57.23 | 3.78 | 903 | 34,297 | 67.23 | 3.07 | 151 | 31,208 | 64.34 | 3.17 |
| rapier | 50 | 1 | 17,260 | 45.04 | 6.26 | 702 | 17,671 | 50.47 | 4.18 | 160 | 17,108 | 49.47 | 5.39 |

## Earlier Rapier build against this one, same run

18 settings were encoded by both builds in alternation; 18 produce identical bytes. Time is CPU ms, median of the alternating runs.

| Group | Effort | Images | Identical | Bytes before | Bytes after | ms before | ms after | Speed-up (geometric mean) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| kodak | 3 | 1 | 1 | 528,969 | 528,969 | 251 | 242 | 1.04x |
| kodak | 7 | 1 | 1 | 488,942 | 488,942 | 3,240 | 3,192 | 1.01x |
| kodak | 9 | 1 | 1 | 470,666 | 470,666 | 39,794 | 15,898 | 2.50x |
| rapier | 3 | 4 | 4 | 458,459 | 458,459 | 902 | 896 | 1.02x |
| rapier | 7 | 4 | 4 | 412,191 | 412,191 | 6,510 | 6,662 | 0.99x |
| rapier | 9 | 4 | 4 | 391,540 | 391,540 | 98,716 | 35,715 | 2.60x |
| pixel | 3 | 1 | 1 | 9,536 | 9,536 | 140 | 145 | 0.96x |
| pixel | 7 | 1 | 1 | 9,388 | 9,388 | 831 | 983 | 0.85x |
| pixel | 9 | 1 | 1 | 7,174 | 7,174 | 12,635 | 5,518 | 2.29x |

