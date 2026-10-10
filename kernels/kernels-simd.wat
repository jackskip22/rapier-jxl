;; SPDX-License-Identifier: MIT
;; Bounded integer kernels. kernels.mjs checks pointers and lengths.
;; Tiny arithmetic helpers are explicitly inlined: Node 22 does not inline WAT calls
;; by default. i64 multiplication followed by arithmetic >>24 is floor, not truncation.
;; SIMD averages add one to negative sums before >>1, matching JavaScript's /2 |0.
(module
  (import "env" "memory" (memory 1 272))
  (func $residual
    (export "residual")
    (param $p i32)
    (param $w i32)
    (param $h i32)
    (param $pred i32)
    (param $offset i32)
    (param $out i32)
    (local $L v128)
    (local $T v128)
    (local $NW v128)
    (local $V v128)
    (local $S v128)
    (local $x i32)
    (local $y i32)
    (local $row i32)
    (local $left i32)
    (local $top i32)
    (local $nw i32)
    (local $g i32)
    (local $v i32)
    (local.set $row (i32.shl (local.get $w) (i32.const 2)))
    (loop $ys
      (local.set $x (i32.const 0))
      (loop $xs
        (block $next
          (if
            (i32.and
              (i32.and (i32.ne (local.get $y) (i32.const 0)) (i32.ne (local.get $x) (i32.const 0)))
              (i32.and
                (i32.le_u (i32.add (local.get $x) (i32.const 4)) (local.get $w))
                (i32.or (i32.eq (local.get $pred) (i32.const 3)) (i32.eq (local.get $pred) (i32.const 5)))))
            (then
              (local.set $L (v128.load (i32.sub (local.get $p) (i32.const 4))))
              (local.set $T (v128.load (i32.sub (local.get $p) (local.get $row))))
              (local.set $S (i32x4.add (local.get $L) (local.get $T)))
              (if
                (i32.eq (local.get $pred) (i32.const 3))
                (then
                  (local.set $V
                    (i32x4.shr_s
                      (i32x4.add
                        (local.get $S)
                        (v128.and (i32x4.shr_s (local.get $S) (i32.const 31)) (i32x4.splat (i32.const 1))))
                      (i32.const 1))))
                (else
                  (local.set $NW (v128.load (i32.sub (i32.sub (local.get $p) (local.get $row)) (i32.const 4))))
                  (local.set $V
                    (i32x4.max_s
                      (i32x4.min_s (local.get $L) (local.get $T))
                      (i32x4.min_s
                        (i32x4.max_s (local.get $L) (local.get $T))
                        (i32x4.sub (local.get $S) (local.get $NW)))))))
              (local.set $V
                (i32x4.sub
                  (i32x4.sub (v128.load (local.get $p)) (local.get $V))
                  (i32x4.splat (local.get $offset))))
              (v128.store
                (local.get $out)
                (v128.xor (i32x4.shl (local.get $V) (i32.const 1)) (i32x4.shr_s (local.get $V) (i32.const 31))))
              (local.set $p (i32.add (local.get $p) (i32.const 16)))
              (local.set $out (i32.add (local.get $out) (i32.const 16)))
              (local.set $x (i32.add (local.get $x) (i32.const 4)))
              (br $next)))
          (local.set $v (i32.const 0))
          (if
            (local.get $pred)
            (then
              (local.set $left
                (if
                  (result i32)
                  (local.get $x)
                  (then (i32.load (i32.sub (local.get $p) (i32.const 4))))
                  (else
                    (if
                      (result i32)
                      (local.get $y)
                      (then (i32.load (i32.sub (local.get $p) (local.get $row))))
                      (else (i32.const 0))))))
              (local.set $top
                (if
                  (result i32)
                  (local.get $y)
                  (then (i32.load (i32.sub (local.get $p) (local.get $row))))
                  (else (local.get $left))))
              (local.set $nw
                (if
                  (result i32)
                  (i32.and (i32.ne (local.get $x) (i32.const 0)) (i32.ne (local.get $y) (i32.const 0)))
                  (then (i32.load (i32.sub (i32.sub (local.get $p) (local.get $row)) (i32.const 4))))
                  (else (local.get $left))))
              (local.set $g (i32.sub (i32.add (local.get $left) (local.get $top)) (local.get $nw)))
              (if (i32.eq (local.get $pred) (i32.const 1)) (then (local.set $v (local.get $left))))
              (if (i32.eq (local.get $pred) (i32.const 2)) (then (local.set $v (local.get $top))))
              (if
                (i32.eq (local.get $pred) (i32.const 3))
                (then (local.set $v (i32.div_s (i32.add (local.get $left) (local.get $top)) (i32.const 2)))))
              (if
                (i32.eq (local.get $pred) (i32.const 4))
                (then
                  (local.set $v
                    (select
                      (local.get $left)
                      (local.get $top)
                      (i32.lt_s
                        (i32.sub
                          (i32.xor
                            (i32.sub (local.get $g) (local.get $left))
                            (i32.shr_s (i32.sub (local.get $g) (local.get $left)) (i32.const 31)))
                          (i32.shr_s (i32.sub (local.get $g) (local.get $left)) (i32.const 31)))
                        (i32.sub
                          (i32.xor
                            (i32.sub (local.get $g) (local.get $top))
                            (i32.shr_s (i32.sub (local.get $g) (local.get $top)) (i32.const 31)))
                          (i32.shr_s (i32.sub (local.get $g) (local.get $top)) (i32.const 31))))))))
              (if
                (i32.eq (local.get $pred) (i32.const 5))
                (then
                  (local.set $v
                    (select
                      (select (local.get $left) (local.get $top) (i32.lt_s (local.get $left) (local.get $top)))
                      (select
                        (select (local.get $left) (local.get $top) (i32.gt_s (local.get $left) (local.get $top)))
                        (local.get $g)
                        (i32.lt_s
                          (select
                            (local.get $left)
                            (local.get $top)
                            (i32.gt_s (local.get $left) (local.get $top)))
                          (local.get $g)))
                      (i32.gt_s
                        (select (local.get $left) (local.get $top) (i32.lt_s (local.get $left) (local.get $top)))
                        (select
                          (select
                            (local.get $left)
                            (local.get $top)
                            (i32.gt_s (local.get $left) (local.get $top)))
                          (local.get $g)
                          (i32.lt_s
                            (select
                              (local.get $left)
                              (local.get $top)
                              (i32.gt_s (local.get $left) (local.get $top)))
                            (local.get $g))))))))))
          (i32.store
            (local.get $out)
            (i32.xor
              (i32.shl
                (i32.sub (i32.sub (i32.load (local.get $p)) (local.get $v)) (local.get $offset))
                (i32.const 1))
              (i32.shr_s
                (i32.sub (i32.sub (i32.load (local.get $p)) (local.get $v)) (local.get $offset))
                (i32.const 31))))
          (local.set $out (i32.add (local.get $out) (i32.const 4)))
          (local.set $p (i32.add (local.get $p) (i32.const 4)))
          (local.set $x (i32.add (local.get $x) (i32.const 1))))
        (br_if $xs (i32.lt_u (local.get $x) (local.get $w))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br_if $ys (i32.lt_u (local.get $y) (local.get $h)))))
  (func $fill
    (export "fill")
    (param $src i32)
    (param $n i32)
    (param $channels i32)
    (param $p0 i32)
    (param $p1 i32)
    (param $p2 i32)
    (param $p3 i32)
    (local $V v128)
    (local $R v128)
    (local $G v128)
    (local $B v128)
    (local $Co v128)
    (local $Cg v128)
    (local $Tmp v128)
    (local $v i32)
    (local $r i32)
    (local $g i32)
    (local $b i32)
    (local $co i32)
    (local $cg i32)
    (local $tmp i32)
    (local $i i32)
    (block $vectorsDone
      (loop $vectors
        (br_if $vectorsDone (i32.gt_u (i32.add (local.get $i) (i32.const 4)) (local.get $n)))
        (local.set $V (v128.load (local.get $src)))
        (local.set $R (v128.and (local.get $V) (i32x4.splat (i32.const 255))))
        (if
          (i32.ge_u (local.get $channels) (i32.const 3))
          (then
            (local.set $G (v128.and (i32x4.shr_u (local.get $V) (i32.const 8)) (i32x4.splat (i32.const 255))))
            (local.set $B (v128.and (i32x4.shr_u (local.get $V) (i32.const 16)) (i32x4.splat (i32.const 255))))
            (local.set $Co (i32x4.sub (local.get $R) (local.get $B)))
            (local.set $Tmp (i32x4.add (local.get $B) (i32x4.shr_s (local.get $Co) (i32.const 1))))
            (local.set $Cg (i32x4.sub (local.get $G) (local.get $Tmp)))
            (v128.store (local.get $p0) (i32x4.add (local.get $Tmp) (i32x4.shr_s (local.get $Cg) (i32.const 1))))
            (v128.store (local.get $p1) (local.get $Co))
            (v128.store (local.get $p2) (local.get $Cg))
            (if
              (i32.eq (local.get $channels) (i32.const 4))
              (then (v128.store (local.get $p3) (i32x4.shr_u (local.get $V) (i32.const 24))))))
          (else
            (v128.store (local.get $p0) (local.get $R))
            (if
              (i32.eq (local.get $channels) (i32.const 2))
              (then (v128.store (local.get $p1) (i32x4.shr_u (local.get $V) (i32.const 24)))))))
        (local.set $p0 (i32.add (local.get $p0) (i32.const 16)))
        (local.set $p1 (i32.add (local.get $p1) (i32.const 16)))
        (local.set $p2 (i32.add (local.get $p2) (i32.const 16)))
        (local.set $p3 (i32.add (local.get $p3) (i32.const 16)))
        (local.set $src (i32.add (local.get $src) (i32.const 16)))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $vectors)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v (i32.load (local.get $src)))
        (local.set $r (i32.and (local.get $v) (i32.const 255)))
        (if
          (i32.ge_u (local.get $channels) (i32.const 3))
          (then
            (local.set $g (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 255)))
            (local.set $b (i32.and (i32.shr_u (local.get $v) (i32.const 16)) (i32.const 255)))
            (local.set $co (i32.sub (local.get $r) (local.get $b)))
            (local.set $tmp (i32.add (local.get $b) (i32.shr_s (local.get $co) (i32.const 1))))
            (local.set $cg (i32.sub (local.get $g) (local.get $tmp)))
            (i32.store (local.get $p0) (i32.add (local.get $tmp) (i32.shr_s (local.get $cg) (i32.const 1))))
            (i32.store (local.get $p1) (local.get $co))
            (i32.store (local.get $p2) (local.get $cg))
            (if
              (i32.eq (local.get $channels) (i32.const 4))
              (then (i32.store (local.get $p3) (i32.shr_u (local.get $v) (i32.const 24))))))
          (else
            (i32.store (local.get $p0) (local.get $r))
            (if
              (i32.eq (local.get $channels) (i32.const 2))
              (then (i32.store (local.get $p1) (i32.shr_u (local.get $v) (i32.const 24)))))))
        (local.set $p0 (i32.add (local.get $p0) (i32.const 4)))
        (local.set $p1 (i32.add (local.get $p1) (i32.const 4)))
        (local.set $p2 (i32.add (local.get $p2) (i32.const 4)))
        (local.set $p3 (i32.add (local.get $p3) (i32.const 4)))
        (local.set $src (i32.add (local.get $src) (i32.const 4)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $next (i32.lt_u (local.get $i) (local.get $n))))))
  ;; A match can overlap its source. Every compared lane remains inside the plane.
  (func $screenSpan (param $a i32) (param $b i32) (param $limit i32) (result i32)
    (local $k i32) (local $mask i32)
    (block $tail
      (loop $four
        (br_if $tail (i32.gt_u (i32.add (local.get $k) (i32.const 4)) (local.get $limit)))
        (local.set $mask (i32x4.bitmask (i32x4.eq (v128.load (local.get $a)) (v128.load (local.get $b)))))
        (if (i32.ne (local.get $mask) (i32.const 15))
          (then (return (i32.add (local.get $k) (i32.ctz (i32.xor (local.get $mask) (i32.const 15)))))))
        (local.set $a (i32.add (local.get $a) (i32.const 16)))
        (local.set $b (i32.add (local.get $b) (i32.const 16)))
        (local.set $k (i32.add (local.get $k) (i32.const 4)))
        (br $four)))
    (block $done
      (loop $one
        (br_if $done (i32.ge_u (local.get $k) (local.get $limit)))
        (br_if $done (i32.ne (i32.load (local.get $a)) (i32.load (local.get $b))))
        (local.set $a (i32.add (local.get $a) (i32.const 4)))
        (local.set $b (i32.add (local.get $b) (i32.const 4)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $one)))
    (local.get $k))

  ;; Full-group chains and exact row hashes. Row hints and chain order match the
  ;; reference, including nearest-distance ties and the first complete match.
  (func (export "screen")
    (param $values i32) (param $n i32) (param $w i32) (param $depth i32)
    (param $head i32) (param $previous i32) (param $rows i32)
    (param $map i32) (param $mask i32) (param $output i32) (result i32)
    (local $start i32) (local $end i32) (local $j i32) (local $h i32)
    (local $slot i32) (local $entry i32) (local $row i32)
    (local $i i32) (local $length i32) (local $distance i32)
    (local $at i32) (local $probes i32) (local $k i32) (local $count i32)
    (local $a i32) (local $b i32) (local $table i32)
    (loop $rowHashes
      (local.set $h (i32.const 2166136261))
      (local.set $j (local.get $start))
      (local.set $end (i32.add (local.get $start) (local.get $w)))
      (loop $rowValues
        (local.set $h (i32.mul (i32.xor (local.get $h) (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $j) (i32.const 2))))) (i32.const 16777619)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br_if $rowValues (i32.lt_u (local.get $j) (local.get $end))))
      (local.set $slot (i32.and (local.get $h) (local.get $mask)))
      (block $found
        (loop $lookup
          (local.set $entry (i32.add (local.get $map) (i32.shl (local.get $slot) (i32.const 3))))
          (br_if $found (i32.eq (i32.load offset=4 (local.get $entry)) (i32.const -1)))
          (br_if $found (i32.eq (i32.load (local.get $entry)) (local.get $h)))
          (local.set $slot (i32.and (i32.add (local.get $slot) (i32.const 1)) (local.get $mask)))
          (br $lookup)))
      (i32.store (i32.add (local.get $rows) (i32.shl (local.get $row) (i32.const 2))) (i32.load offset=4 (local.get $entry)))
      (i32.store (local.get $entry) (local.get $h))
      (i32.store offset=4 (local.get $entry) (local.get $start))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (local.set $start (local.get $end))
      (br_if $rowHashes (i32.lt_u (local.get $start) (local.get $n))))
    (loop $positions
      (local.set $length (i32.const 0))
      (local.set $distance (i32.const 0))
      (if (i32.le_u (i32.add (local.get $i) (i32.const 7)) (local.get $n))
        (then
          (local.set $at (i32.load (i32.add (local.get $rows) (i32.shl (i32.div_u (local.get $i) (local.get $w)) (i32.const 2)))))
          (if (i32.ge_s (local.get $at) (i32.const 0))
            (then (local.set $at (i32.add (local.get $at) (i32.rem_u (local.get $i) (local.get $w))))))
          (local.set $probes (i32.const -1))
          (block $matched
            (loop $candidates
              (block $skip
                (br_if $skip (i32.ge_u (local.get $at) (local.get $i)))
                (br_if $skip (i32.ne (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $at) (i32.const 2)))) (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2))))))
                (local.set $a (i32.add (local.get $values) (i32.shl (local.get $at) (i32.const 2))))
                (local.set $b (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2))))
                (if (local.get $length)
                  (then
                    (local.set $k (i32.shl (local.get $length) (i32.const 2)))
                    (br_if $skip (i32.ne
                      (i32.load (i32.sub (i32.add (local.get $a) (local.get $k)) (i32.const 4)))
                      (i32.load (i32.sub (i32.add (local.get $b) (local.get $k)) (i32.const 4)))))
                    (if (i32.ge_u (i32.sub (local.get $i) (local.get $at)) (local.get $distance))
                      (then
                        (br_if $skip (i32.ge_u (i32.add (local.get $i) (local.get $length)) (local.get $n)))
                        (br_if $skip (i32.ne
                          (i32.load (i32.add (local.get $a) (local.get $k)))
                          (i32.load (i32.add (local.get $b) (local.get $k)))))))))
                (local.set $k (call $screenSpan (local.get $a) (local.get $b) (i32.sub (local.get $n) (local.get $i))))
                (if (i32.or (i32.gt_u (local.get $k) (local.get $length))
                      (i32.and (i32.eq (local.get $k) (local.get $length))
                        (i32.lt_u (i32.sub (local.get $i) (local.get $at)) (local.get $distance))))
                  (then
                    (local.set $length (local.get $k))
                    (local.set $distance (i32.sub (local.get $i) (local.get $at))))))
              (br_if $matched (i32.eq (i32.add (local.get $i) (local.get $length)) (local.get $n)))
              (br_if $matched (i32.ge_s (i32.add (local.get $probes) (i32.const 1)) (local.get $depth)))
              (if (i32.eq (local.get $probes) (i32.const -1))
                (then
                  (local.set $h (i32.shr_u (i32.xor (i32.xor (i32.mul (i32.add (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 506832829)) (i32.mul (i32.add (i32.load offset=4 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 1821285621))) (i32.mul (i32.add (i32.load offset=8 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 739982445))) (i32.const 16)))
                  (local.set $at (i32.load offset=0 (i32.add (local.get $head) (i32.shl (local.get $h) (i32.const 2))))))
                (else (local.set $at (i32.load offset=0 (i32.add (local.get $previous) (i32.shl (local.get $at) (i32.const 2)))))))
              (br_if $matched (i32.lt_s (local.get $at) (i32.const 0)))
              (local.set $probes (i32.add (local.get $probes) (i32.const 1)))
              (br $candidates)))))
      (if (i32.ge_u (local.get $length) (i32.const 7))
        (then
          (i32.store (local.get $output) (local.get $length))
          (i32.store offset=4 (local.get $output) (local.get $distance)))
        (else
          (local.set $length (i32.const 1))
          (i32.store (local.get $output) (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))))
          (i32.store offset=4 (local.get $output) (i32.const 0))))
      (local.set $output (i32.add (local.get $output) (i32.const 8)))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (local.set $end (i32.add (local.get $i) (local.get $length)))
      (block $inserted
        (loop $insert
          (br_if $inserted (i32.ge_u (i32.add (local.get $i) (i32.const 2)) (local.get $n)))
          (local.set $h (i32.shr_u (i32.xor (i32.xor (i32.mul (i32.add (i32.load offset=0 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 506832829)) (i32.mul (i32.add (i32.load offset=4 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 1821285621))) (i32.mul (i32.add (i32.load offset=8 (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))) (i32.const 1)) (i32.const 739982445))) (i32.const 16)))
          (local.set $table (i32.add (local.get $head) (i32.shl (local.get $h) (i32.const 2))))
          (i32.store (i32.add (local.get $previous) (i32.shl (local.get $i) (i32.const 2))) (i32.load (local.get $table)))
          (i32.store (local.get $table) (local.get $i))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $insert (i32.lt_u (local.get $i) (local.get $end)))))
      (local.set $i (local.get $end))
      (br_if $positions (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $count))

  ;; Exact sampled-tree count and sweep with independent low/high f64x2 lanes. The host checks all pointers and lengths.
  ;; symbols: candidate-major u8[kinds * total], indices: u8[total].
  ;; hist: candidate-major u32[kinds * alphabet]; table and raw: exact-integer f64.
  ;; scratch must be 8-byte aligned. Layout: stats, low, high, dense, order, start, next.
  ;; Bytes: kinds*32 + kinds*alphabet*8 + (cuts+1)*kinds*alphabet*4
  ;;        + total*4 + (2*(cuts+1)+1)*4.
  ;; stats per candidate: lowTable, highTable, lowRaw, highRaw, each f64.
  ;; Returns the earliest minimum-cost valid cut, or -1. out: i32 lo, i32 hi,
  ;; f64 loBits, f64 hiBits. The host rejects a nonpositive gain.
  (func $sampled (export "sampled")
    (param $symbols i32) (param $total i32) (param $kinds i32)
    (param $indices i32) (param $cuts i32) (param $alphabet i32)
    (param $hist i32) (param $table i32) (param $raw i32)
    (param $scratch i32) (param $out i32) (result i32)
    (local $bins i32) (local $cells i32) (local $denseSize i32)
    (local $low i32) (local $high i32) (local $dense i32)
    (local $order i32) (local $start i32) (local $next i32)
    (local $useDense i32) (local $c i32) (local $s i32) (local $i i32)
    (local $b i32) (local $j i32) (local $v i32) (local $l i32) (local $h i32)
    (local $p i32) (local $q i32) (local $lo i32) (local $hi i32)
    (local $stats i32) (local $row i32) (local $from i32) (local $end i32)
    (local $moved i32) (local $lowCount i32)
    (local $loSelected i32) (local $hiSelected i32) (local $bestBin i32)
    (local $t f64) (local $u f64) (local $r f64)
    (local $delta v128) (local $totals v128) (local $rawTotals v128) (local $costs v128)
    (local $lt f64) (local $ht f64) (local $lr f64) (local $hr f64)
    (local $lowBase f64) (local $highBase f64)
    (local $loBits f64) (local $hiBits f64) (local $price f64) (local $best f64)
    (if (i32.or (i32.lt_u (local.get $total) (i32.const 64))
          (i32.or (i32.eqz (local.get $cuts))
            (i32.or (i32.eqz (local.get $kinds)) (i32.eqz (local.get $alphabet)))))
      (then (return (i32.const -1))))
    (local.set $bins (i32.add (local.get $cuts) (i32.const 1)))
    (local.set $cells (i32.mul (local.get $kinds) (local.get $alphabet)))
    (local.set $denseSize (i32.mul (local.get $bins) (local.get $cells)))
    (local.set $low (i32.add (local.get $scratch) (i32.shl (local.get $kinds) (i32.const 5))))
    (local.set $high (i32.add (local.get $low) (i32.shl (local.get $cells) (i32.const 2))))
    (local.set $dense (i32.add (local.get $high) (i32.shl (local.get $cells) (i32.const 2))))
    (local.set $order (i32.add (local.get $dense) (i32.shl (local.get $denseSize) (i32.const 2))))
    (local.set $start (i32.add (local.get $order) (i32.shl (local.get $total) (i32.const 2))))
    (local.set $next (i32.add (local.get $start) (i32.shl (i32.add (local.get $bins) (i32.const 1)) (i32.const 2))))
    ;; This is the original threshold, not a threshold based on occupied symbols.
    (local.set $useDense (i32.gt_u (i32.shl (local.get $total) (i32.const 2))
      (i32.mul (local.get $bins) (local.get $alphabet))))
    (local.set $bestBin (i32.const -1))
    (local.set $best (f64.const inf))
    ;; Initialize both count sides and their exact running sums.
    (local.set $c (i32.const 0))
    (loop $initializeCandidates
      (local.set $t (f64.const 0)) (local.set $r (f64.const 0))
      (local.set $s (i32.const 0))
      (loop $initializeSymbols
        (local.set $p (i32.shl (i32.add (i32.mul (local.get $c) (local.get $alphabet)) (local.get $s)) (i32.const 2)))
        (local.set $h (i32.load (i32.add (local.get $hist) (local.get $p))))
        (i32.store (i32.add (local.get $low) (local.get $p)) (i32.const 0))
        (i32.store (i32.add (local.get $high) (local.get $p)) (local.get $h))
        (local.set $t (f64.add (local.get $t) (f64.load (i32.add (local.get $table) (i32.shl (local.get $h) (i32.const 3))))))
        (local.set $r (f64.add (local.get $r) (f64.mul (f64.convert_i32_u (local.get $h))
          (f64.load (i32.add (local.get $raw) (i32.shl (local.get $s) (i32.const 3)))))))
        (local.set $s (i32.add (local.get $s) (i32.const 1)))
        (br_if $initializeSymbols (i32.lt_u (local.get $s) (local.get $alphabet))))
      (local.set $stats (i32.add (local.get $scratch) (i32.shl (local.get $c) (i32.const 5))))
      (f64.store (local.get $stats) (f64.const 0))
      (f64.store offset=8 (local.get $stats) (local.get $t))
      (f64.store offset=16 (local.get $stats) (f64.const 0))
      (f64.store offset=24 (local.get $stats) (local.get $r))
      (local.set $c (i32.add (local.get $c) (i32.const 1)))
      (br_if $initializeCandidates (i32.lt_u (local.get $c) (local.get $kinds))))
    (if (local.get $useDense)
      (then
        (local.set $i (i32.const 0))
        (loop $zeroDense
          (i32.store (i32.add (local.get $dense) (i32.shl (local.get $i) (i32.const 2))) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $zeroDense (i32.lt_u (local.get $i) (local.get $denseSize))))
        (local.set $c (i32.const 0))
        (loop $countCandidates
          (local.set $row (i32.mul (i32.mul (local.get $c) (local.get $bins)) (local.get $alphabet)))
          (local.set $from (i32.add (local.get $symbols) (i32.mul (local.get $c) (local.get $total))))
          (local.set $i (i32.const 0))
          (loop $countSamples
            (local.set $b (i32.load8_u (i32.add (local.get $indices) (local.get $i))))
            (local.set $s (i32.load8_u (i32.add (local.get $from) (local.get $i))))
            (local.set $p (i32.add (local.get $dense) (i32.shl
              (i32.add (local.get $row) (i32.add (i32.mul (local.get $b) (local.get $alphabet)) (local.get $s))) (i32.const 2))))
            (i32.store (local.get $p) (i32.add (i32.load (local.get $p)) (i32.const 1)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br_if $countSamples (i32.lt_u (local.get $i) (local.get $total))))
          (local.set $c (i32.add (local.get $c) (i32.const 1)))
          (br_if $countCandidates (i32.lt_u (local.get $c) (local.get $kinds)))))
      (else
        ;; Stable counting-sort order for the sparse, one-sample-at-a-time sweep.
        (local.set $b (i32.const 0))
        (loop $zeroStart
          (i32.store (i32.add (local.get $start) (i32.shl (local.get $b) (i32.const 2))) (i32.const 0))
          (local.set $b (i32.add (local.get $b) (i32.const 1)))
          (br_if $zeroStart (i32.le_u (local.get $b) (local.get $bins))))
        (local.set $i (i32.const 0))
        (loop $countBins
          (local.set $b (i32.load8_u (i32.add (local.get $indices) (local.get $i))))
          (local.set $p (i32.add (local.get $start) (i32.shl (i32.add (local.get $b) (i32.const 1)) (i32.const 2))))
          (i32.store (local.get $p) (i32.add (i32.load (local.get $p)) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $countBins (i32.lt_u (local.get $i) (local.get $total))))
        (local.set $b (i32.const 0))
        (loop $prefixBins
          (local.set $p (i32.add (local.get $start) (i32.shl (local.get $b) (i32.const 2))))
          (local.set $v (i32.load (local.get $p)))
          (i32.store offset=4 (local.get $p) (i32.add (local.get $v) (i32.load offset=4 (local.get $p))))
          (i32.store (i32.add (local.get $next) (i32.shl (local.get $b) (i32.const 2))) (local.get $v))
          (local.set $b (i32.add (local.get $b) (i32.const 1)))
          (br_if $prefixBins (i32.lt_u (local.get $b) (local.get $bins))))
        (local.set $i (i32.const 0))
        (loop $orderSamples
          (local.set $b (i32.load8_u (i32.add (local.get $indices) (local.get $i))))
          (local.set $p (i32.add (local.get $next) (i32.shl (local.get $b) (i32.const 2))))
          (local.set $v (i32.load (local.get $p)))
          (i32.store (i32.add (local.get $order) (i32.shl (local.get $v) (i32.const 2))) (local.get $i))
          (i32.store (local.get $p) (i32.add (local.get $v) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $orderSamples (i32.lt_u (local.get $i) (local.get $total))))))
    (local.set $b (i32.const 0))
    (loop $sweepBins
      (local.set $moved (i32.const 0))
      (if (local.get $useDense)
        (then
          (local.set $c (i32.const 0))
          (loop $denseCandidates
            (local.set $row (i32.add (local.get $dense) (i32.shl
              (i32.mul (i32.add (i32.mul (local.get $c) (local.get $bins)) (local.get $b)) (local.get $alphabet)) (i32.const 2))))
            (local.set $p (i32.shl (i32.mul (local.get $c) (local.get $alphabet)) (i32.const 2)))
            (local.set $lo (i32.add (local.get $low) (local.get $p)))
            (local.set $hi (i32.add (local.get $high) (local.get $p)))
            (local.set $delta (v128.const f64x2 0 0)) (local.set $r (f64.const 0))
            (local.set $s (i32.const 0))
            (loop $denseSymbols
              (local.set $p (i32.shl (local.get $s) (i32.const 2)))
              (local.set $v (i32.load (i32.add (local.get $row) (local.get $p))))
              (if (local.get $v)
                (then
                  (local.set $l (i32.load (i32.add (local.get $lo) (local.get $p))))
                  (local.set $h (i32.load (i32.add (local.get $hi) (local.get $p))))
                  ;; Each lane has the scalar symbol-order recurrence. No horizontal reduction.
                  (local.set $delta (f64x2.add (local.get $delta) (f64x2.sub
                    (f64x2.replace_lane 1
                      (f64x2.splat (f64.load (i32.add (local.get $table) (i32.shl (i32.add (local.get $l) (local.get $v)) (i32.const 3)))))
                      (f64.load (i32.add (local.get $table) (i32.shl (i32.sub (local.get $h) (local.get $v)) (i32.const 3)))))
                    (f64x2.replace_lane 1
                      (f64x2.splat (f64.load (i32.add (local.get $table) (i32.shl (local.get $l) (i32.const 3)))))
                      (f64.load (i32.add (local.get $table) (i32.shl (local.get $h) (i32.const 3))))))))
                  (local.set $r (f64.add (local.get $r) (f64.mul (f64.convert_i32_u (local.get $v))
                    (f64.load (i32.add (local.get $raw) (i32.shl (local.get $s) (i32.const 3)))))))
                  (i32.store (i32.add (local.get $lo) (local.get $p)) (i32.add (local.get $l) (local.get $v)))
                  (i32.store (i32.add (local.get $hi) (local.get $p)) (i32.sub (local.get $h) (local.get $v)))
                  (if (i32.eqz (local.get $c)) (then (local.set $moved (i32.add (local.get $moved) (local.get $v)))))))
              (local.set $s (i32.add (local.get $s) (i32.const 1)))
              (br_if $denseSymbols (i32.lt_u (local.get $s) (local.get $alphabet))))
            (local.set $stats (i32.add (local.get $scratch) (i32.shl (local.get $c) (i32.const 5))))
            (v128.store (local.get $stats) (f64x2.add (v128.load (local.get $stats)) (local.get $delta)))
            (v128.store offset=16 (local.get $stats) (f64x2.add (v128.load offset=16 (local.get $stats))
              (f64x2.replace_lane 1 (f64x2.splat (local.get $r)) (f64.neg (local.get $r)))))
            (local.set $c (i32.add (local.get $c) (i32.const 1)))
            (br_if $denseCandidates (i32.lt_u (local.get $c) (local.get $kinds)))))
        (else
          (local.set $p (i32.add (local.get $start) (i32.shl (local.get $b) (i32.const 2))))
          (local.set $from (i32.load (local.get $p)))
          (local.set $end (i32.load offset=4 (local.get $p)))
          (local.set $moved (i32.sub (local.get $end) (local.get $from)))
          (if (local.get $moved)
            (then
              (local.set $c (i32.const 0))
              (loop $sparseCandidates
                (local.set $p (i32.shl (i32.mul (local.get $c) (local.get $alphabet)) (i32.const 2)))
                (local.set $lo (i32.add (local.get $low) (local.get $p)))
                (local.set $hi (i32.add (local.get $high) (local.get $p)))
                (local.set $row (i32.add (local.get $symbols) (i32.mul (local.get $c) (local.get $total))))
                (local.set $stats (i32.add (local.get $scratch) (i32.shl (local.get $c) (i32.const 5))))
                (local.set $totals (v128.load (local.get $stats)))
                (local.set $rawTotals (v128.load offset=16 (local.get $stats)))
                (local.set $i (local.get $from))
                (loop $sparseSamples
                  (local.set $j (i32.load (i32.add (local.get $order) (i32.shl (local.get $i) (i32.const 2)))))
                  (local.set $s (i32.load8_u (i32.add (local.get $row) (local.get $j))))
                  (local.set $p (i32.shl (local.get $s) (i32.const 2)))
                  (local.set $l (i32.load (i32.add (local.get $lo) (local.get $p))))
                  (local.set $h (i32.load (i32.add (local.get $hi) (local.get $p))))
                  (local.set $totals (f64x2.add (local.get $totals) (f64x2.sub
                    (f64x2.replace_lane 1
                      (f64x2.splat (f64.load (i32.add (local.get $table) (i32.shl (i32.add (local.get $l) (i32.const 1)) (i32.const 3)))))
                      (f64.load (i32.add (local.get $table) (i32.shl (i32.sub (local.get $h) (i32.const 1)) (i32.const 3)))))
                    (f64x2.replace_lane 1
                      (f64x2.splat (f64.load (i32.add (local.get $table) (i32.shl (local.get $l) (i32.const 3)))))
                      (f64.load (i32.add (local.get $table) (i32.shl (local.get $h) (i32.const 3))))))))
                  (local.set $r (f64.load (i32.add (local.get $raw) (i32.shl (local.get $s) (i32.const 3)))))
                  (local.set $rawTotals (f64x2.add (local.get $rawTotals)
                    (f64x2.replace_lane 1 (f64x2.splat (local.get $r)) (f64.neg (local.get $r)))))
                  (i32.store (i32.add (local.get $lo) (local.get $p)) (i32.add (local.get $l) (i32.const 1)))
                  (i32.store (i32.add (local.get $hi) (local.get $p)) (i32.sub (local.get $h) (i32.const 1)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br_if $sparseSamples (i32.lt_u (local.get $i) (local.get $end))))
                (v128.store (local.get $stats) (local.get $totals))
                (v128.store offset=16 (local.get $stats) (local.get $rawTotals))
                (local.set $c (i32.add (local.get $c) (i32.const 1)))
                (br_if $sparseCandidates (i32.lt_u (local.get $c) (local.get $kinds))))))))
      (local.set $lowCount (i32.add (local.get $lowCount) (local.get $moved)))
      (if (i32.and (i32.ne (local.get $moved) (i32.const 0))
            (i32.and (i32.ge_u (local.get $lowCount) (i32.const 24))
              (i32.ge_u (i32.sub (local.get $total) (local.get $lowCount)) (i32.const 24))))
        (then
          (local.set $lowBase (f64.load (i32.add (local.get $table) (i32.shl (local.get $lowCount) (i32.const 3)))))
          (local.set $highBase (f64.load (i32.add (local.get $table) (i32.shl (i32.sub (local.get $total) (local.get $lowCount)) (i32.const 3)))))
          (local.set $loBits (f64.const inf)) (local.set $hiBits (f64.const inf))
          (local.set $loSelected (i32.const 0)) (local.set $hiSelected (i32.const 0))
          (local.set $c (i32.const 0))
          (loop $chooseCandidates
            (local.set $stats (i32.add (local.get $scratch) (i32.shl (local.get $c) (i32.const 5))))
            (local.set $costs (f64x2.add
              (f64x2.sub (f64x2.replace_lane 1 (f64x2.splat (local.get $lowBase)) (local.get $highBase))
                (v128.load (local.get $stats)))
              (v128.load offset=16 (local.get $stats))))
            (local.set $t (f64x2.extract_lane 0 (local.get $costs)))
            (local.set $u (f64x2.extract_lane 1 (local.get $costs)))
            (if (f64.lt (local.get $t) (local.get $loBits))
              (then (local.set $loBits (local.get $t)) (local.set $loSelected (local.get $c))))
            (if (f64.lt (local.get $u) (local.get $hiBits))
              (then (local.set $hiBits (local.get $u)) (local.set $hiSelected (local.get $c))))
            (local.set $c (i32.add (local.get $c) (i32.const 1)))
            (br_if $chooseCandidates (i32.lt_u (local.get $c) (local.get $kinds))))
          (local.set $price (f64.add (local.get $loBits) (local.get $hiBits)))
          (if (f64.lt (local.get $price) (local.get $best))
            (then
              (local.set $best (local.get $price)) (local.set $bestBin (local.get $b))
              (i32.store (local.get $out) (local.get $loSelected))
              (i32.store offset=4 (local.get $out) (local.get $hiSelected))
              (f64.store offset=8 (local.get $out) (local.get $loBits))
              (f64.store offset=16 (local.get $out) (local.get $hiBits))))))
      (local.set $b (i32.add (local.get $b) (i32.const 1)))
      (br_if $sweepBins (i32.lt_u (local.get $b) (local.get $cuts))))
    (local.get $bestBin))

)
