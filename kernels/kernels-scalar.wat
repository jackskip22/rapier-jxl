;; SPDX-License-Identifier: MIT
;; Bounded integer kernels. kernels.mjs checks pointers and lengths.
;; Tiny arithmetic helpers are explicitly inlined: Node 22 does not inline WAT calls
;; by default. i64 multiplication followed by arithmetic >>24 is floor, not truncation.
;; SIMD averages add one to negative sums before >>1, matching JavaScript's /2 |0.
(module
  (import "env" "memory" (memory 1 272))
  (global $table (mut i32) (i32.const 0))
  (global $out (mut i32) (i32.const 0))
  (global $writing (mut i32) (i32.const 0))
  (global $acc (mut i64) (i64.const 0))
  (global $pending (mut i32) (i32.const 0))
  ;; The residual tokens' hybrid-integer configuration (split, msb, lsb; splittoken is 1 << split), and the histogram
  ;; layout: a bin per context of $stride entries, LZ77 length tokens at $lenbase. A raw histogram ($raw) holds a
  ;; literal's own value in its own bin and the 33 length tokens in its last 33.
  (global $split (mut i32) (i32.const 0))
  (global $msb (mut i32) (i32.const 0))
  (global $lsb (mut i32) (i32.const 0))
  (global $splittoken (mut i32) (i32.const 1))
  (global $stride (mut i32) (i32.const 257))
  (global $lenbase (mut i32) (i32.const 224))
  (global $raw (mut i32) (i32.const 0))
  (func $residual
    (export "residual")
    (param $p i32)
    (param $w i32)
    (param $h i32)
    (param $pred i32)
    (param $offset i32)
    (param $out i32)
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
                        (select (local.get $left) (local.get $top) (i32.gt_s (local.get $left) (local.get $top)))
                        (local.get $g)))
                    (i32.gt_s
                      (select (local.get $left) (local.get $top) (i32.lt_s (local.get $left) (local.get $top)))
                      (select
                        (select (local.get $left) (local.get $top) (i32.gt_s (local.get $left) (local.get $top)))
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
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br_if $xs (i32.lt_u (local.get $x) (local.get $w))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br_if $ys (i32.lt_u (local.get $y) (local.get $h)))))
  (func $bits
    (param $n i32)
    (param $v i32)
    (global.set $acc
      (i64.or
        (global.get $acc)
        (i64.shl (i64.extend_i32_u (local.get $v)) (i64.extend_i32_u (global.get $pending)))))
    (global.set $pending (i32.add (global.get $pending) (local.get $n)))
    (block $done
      (loop $bytes
        (br_if $done (i32.lt_u (global.get $pending) (i32.const 8)))
        (i32.store8 (global.get $out) (i32.wrap_i64 (global.get $acc)))
        (global.set $out (i32.add (global.get $out) (i32.const 1)))
        (global.set $acc (i64.shr_u (global.get $acc) (i64.const 8)))
        (global.set $pending (i32.sub (global.get $pending) (i32.const 8)))
        (br $bytes))))
  (func $emit
    (param $context i32)
    (param $value i32)
    (param $run i32)
    (local $symbol i32)
    (local $n i32)
    (local $nbits i32)
    (local $extra i32)
    (local $below i32)
    (local $at i32)
    (if
      (local.get $run)
      (then
        ;; An LZ77 length, split 4: a value below 16 is its own token, above it n + 12 with n raw bits.
        (if
          (i32.lt_u (local.get $value) (i32.const 16))
          (then (local.set $symbol (i32.add (local.get $value) (global.get $lenbase))))
          (else
            (local.set $n (i32.sub (i32.const 31) (i32.clz (local.get $value))))
            (local.set $symbol (i32.add (i32.add (local.get $n) (i32.const 12)) (global.get $lenbase)))
            (local.set $nbits (local.get $n))
            (local.set $extra
              (i32.and (local.get $value) (i32.sub (i32.shl (i32.const 1) (local.get $n)) (i32.const 1)))))))
      (else
        (if
          (global.get $raw)
          (then
            ;; The literal's own bin; a value past the histogram is not counted, as a write past an array's end.
            (if (i32.ge_u (local.get $value) (global.get $stride)) (then (return)))
            (local.set $symbol (local.get $value)))
          (else
            (if
              (i32.lt_u (local.get $value) (global.get $splittoken))
              (then (local.set $symbol (local.get $value)))
              (else
                (local.set $n (i32.sub (i32.const 31) (i32.clz (local.get $value))))
                (if
                  (i32.eqz (i32.or (global.get $msb) (global.get $lsb)))
                  (then
                    ;; Every bit under the top one raw.
                    (local.set $symbol (i32.add (global.get $splittoken) (i32.sub (local.get $n) (global.get $split))))
                    (local.set $nbits (local.get $n))
                    (local.set $extra
                      (i32.and (local.get $value) (i32.sub (i32.shl (i32.const 1) (local.get $n)) (i32.const 1)))))
                  (else
                    (local.set $below (i32.sub (local.get $value) (i32.shl (i32.const 1) (local.get $n))))
                    (local.set $nbits (i32.sub (i32.sub (local.get $n) (global.get $msb)) (global.get $lsb)))
                    (local.set $symbol
                      (i32.add
                        (global.get $splittoken)
                        (i32.or
                          (i32.or
                            (i32.shl
                              (i32.sub (local.get $n) (global.get $split))
                              (i32.add (global.get $msb) (global.get $lsb)))
                            (i32.shl
                              (i32.shr_u (local.get $below) (i32.sub (local.get $n) (global.get $msb)))
                              (global.get $lsb)))
                          (i32.and
                            (local.get $below)
                            (i32.sub (i32.shl (i32.const 1) (global.get $lsb)) (i32.const 1))))))
                    (local.set $extra
                      (i32.and
                        (i32.shr_u (local.get $value) (global.get $lsb))
                        (i32.sub (i32.shl (i32.const 1) (local.get $nbits)) (i32.const 1))))))))))))
    (if
      (global.get $writing)
      (then
        (local.set $at
          (i32.add
            (global.get $table)
            (i32.shl (i32.add (i32.mul (local.get $context) (global.get $stride)) (local.get $symbol)) (i32.const 3))))
        (call $bits (i32.load (local.get $at)) (i32.load offset=4 (local.get $at)))
        (if (local.get $nbits) (then (call $bits (local.get $nbits) (local.get $extra)))))
      (else
        (local.set $at
          (i32.add
            (global.get $table)
            (i32.shl (i32.add (i32.mul (local.get $context) (global.get $stride)) (local.get $symbol)) (i32.const 2))))
        (i32.store (local.get $at) (i32.add (i32.load (local.get $at)) (i32.const 1))))))
  (func $context
    (param $contexts i32)
    (param $i i32)
    (result i32)
    (if
      (result i32)
      (local.get $contexts)
      (then (i32.load (i32.add (local.get $contexts) (i32.shl (local.get $i) (i32.const 2)))))
      (else (i32.const 0))))
  (func $tokens
    (export "tokens")
    (param $values i32)
    (param $contexts i32)
    (param $n i32)
    (param $table i32)
    (param $out i32)
    (param $writing i32)
    (param $acc i32)
    (param $pending i32)
    (param $split i32)
    (param $msb i32)
    (param $lsb i32)
    (param $rawlen i32)
    (result i32)
    (local $i i32)
    (local $run i32)
    (local $v i32)
    (local $j i32)
    (global.set $table (local.get $table))
    (global.set $out (local.get $out))
    (global.set $writing (local.get $writing))
    (global.set $acc (i64.extend_i32_u (local.get $acc)))
    (global.set $pending (local.get $pending))
    (global.set $split (local.get $split))
    (global.set $msb (local.get $msb))
    (global.set $lsb (local.get $lsb))
    (global.set $splittoken (i32.shl (i32.const 1) (local.get $split)))
    (global.set $raw (i32.ne (local.get $rawlen) (i32.const 0)))
    (global.set $stride (select (local.get $rawlen) (i32.const 257) (local.get $rawlen)))
    (global.set $lenbase (select (i32.sub (local.get $rawlen) (i32.const 33)) (i32.const 224) (local.get $rawlen)))
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v (i32.load (i32.add (local.get $values) (i32.shl (local.get $i) (i32.const 2)))))
        (local.set $run (i32.const 1))
        (if
          (i32.eqz (local.get $v))
          (then
            (block $endrun
              (loop $zeros
                (br_if $endrun (i32.ge_u (i32.add (local.get $i) (local.get $run)) (local.get $n)))
                (br_if $endrun
                  (i32.load
                    (i32.add
                      (local.get $values)
                      (i32.shl (i32.add (local.get $i) (local.get $run)) (i32.const 2)))))
                (local.set $run (i32.add (local.get $run) (i32.const 1)))
                (br $zeros)))))
        (call $emit (call $context (local.get $contexts) (local.get $i)) (local.get $v) (i32.const 0))
        (if
          (i32.gt_u (local.get $run) (i32.const 7))
          (then
            (call $emit
              (call $context (local.get $contexts) (i32.add (local.get $i) (i32.const 1)))
              (i32.sub (local.get $run) (i32.const 8))
              (i32.const 1)))
          (else
            (local.set $j (i32.const 1))
            (block $shortdone
              (loop $short
                (br_if $shortdone (i32.ge_u (local.get $j) (local.get $run)))
                (call $emit
                  (call $context (local.get $contexts) (i32.add (local.get $i) (local.get $j)))
                  (i32.const 0)
                  (i32.const 0))
                (local.set $j (i32.add (local.get $j) (i32.const 1)))
                (br $short)))))
        (local.set $i (i32.add (local.get $i) (local.get $run)))
        (br $next)))
    (i32.store (i32.sub (local.get $out) (i32.const 8)) (i32.wrap_i64 (global.get $acc)))
    (i32.store (i32.sub (local.get $out) (i32.const 4)) (global.get $pending))
    (i32.sub (global.get $out) (local.get $out)))
  (func $fill
    (export "fill")
    (param $src i32)
    (param $n i32)
    (param $channels i32)
    (param $p0 i32)
    (param $p1 i32)
    (param $p2 i32)
    (param $p3 i32)
    (local $v i32)
    (local $r i32)
    (local $g i32)
    (local $b i32)
    (local $co i32)
    (local $cg i32)
    (local $tmp i32)
    (local $i i32)
    (loop $next
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
      (br_if $next (i32.lt_u (local.get $i) (local.get $n)))))
  (func $weighted
    (export "weighted")
    (param $p i32)
    (param $width i32)
    (param $height i32)
    (param $offset i32)
    (param $out i32)
    (param $properties i32)
    (param $contexts i32)
    (param $map i32)
    (param $bucket i32)
    (param $div i32)
    (param $weights i32)
    (param $state i32)
    (local $wshift i32)
    (local $wsum i32)
    (local $stride i32)
    (local $row i32)
    (local $x i32)
    (local $y i32)
    (local $cur i32)
    (local $prev i32)
    (local $n i32)
    (local $ne i32)
    (local $nw i32)
    (local $left i32)
    (local $top i32)
    (local $right i32)
    (local $N i32)
    (local $W i32)
    (local $NE i32)
    (local $teW i32)
    (local $teN i32)
    (local $teNW i32)
    (local $teNE i32)
    (local $most i32)
    (local $sumWN i32)
    (local $p0 i32)
    (local $p1 i32)
    (local $p2 i32)
    (local $p3 i32)
    (local $w0 i32)
    (local $w1 i32)
    (local $w2 i32)
    (local $w3 i32)
    (local $shift i32)
    (local $sum i32)
    (local $pred i32)
    (local $value i32)
    (local $v i32)
    (local $e0 i32)
    (local $e1 i32)
    (local $e2 i32)
    (local $e3 i32)
    (local $errors0 i32)
    (local $errors1 i32)
    (local $errors2 i32)
    (local $errors3 i32)
    (local $error i32)
    (local $at i32)
    (local.set $stride (i32.shl (i32.add (local.get $width) (i32.const 2)) (i32.const 2)))
    (local.set $row (i32.shl (local.get $width) (i32.const 2)))
    (local.set $errors0 (local.get $state))
    (local.set $errors1 (i32.add (local.get $state) (i32.mul (local.get $stride) (i32.const 2))))
    (local.set $errors2 (i32.add (local.get $state) (i32.mul (local.get $stride) (i32.const 4))))
    (local.set $errors3 (i32.add (local.get $state) (i32.mul (local.get $stride) (i32.const 6))))
    (local.set $error (i32.add (local.get $state) (i32.mul (local.get $stride) (i32.const 8))))
    (loop $ys
      (local.set $cur (select (i32.const 0) (local.get $stride) (i32.and (local.get $y) (i32.const 1))))
      (local.set $prev (i32.sub (local.get $stride) (local.get $cur)))
      (local.set $x (i32.const 0))
      (loop $xs
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
        (local.set $right
          (if
            (result i32)
            (i32.and
              (i32.lt_u (i32.add (local.get $x) (i32.const 1)) (local.get $width))
              (i32.ne (local.get $y) (i32.const 0)))
            (then (i32.load (i32.add (i32.sub (local.get $p) (local.get $row)) (i32.const 4))))
            (else (local.get $top))))
        (local.set $n (i32.add (local.get $prev) (i32.shl (local.get $x) (i32.const 2))))
        (local.set $nw (select (i32.sub (local.get $n) (i32.const 4)) (local.get $n) (local.get $x)))
        (local.set $ne
          (select
            (i32.add (local.get $n) (i32.const 4))
            (local.get $n)
            (i32.lt_u (i32.add (local.get $x) (i32.const 1)) (local.get $width))))
        (local.set $wsum
          (i32.add
            (i32.add
              (i32.load (i32.add (local.get $errors0) (local.get $n)))
              (i32.load (i32.add (local.get $errors0) (local.get $ne))))
            (i32.load (i32.add (local.get $errors0) (local.get $nw)))))
        (if
          (i32.lt_u (local.get $wsum) (i32.const 2048))
          (then
            (local.set $w0
              (i32.load
                (i32.add
                  (local.get $weights)
                  (i32.shl (i32.add (local.get $wsum) (i32.const 2048)) (i32.const 2))))))
          (else
            (local.set $wshift
              (select
                (i32.const 0)
                (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1))))
                (i32.gt_s
                  (i32.const 0)
                  (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1)))))))
            (local.set $w0
              (i32.add
                (i32.const 4)
                (i32.shr_s
                  (i32.mul
                    (i32.const 13)
                    (i32.load
                      (i32.add
                        (local.get $div)
                        (i32.shl (i32.shr_s (local.get $wsum) (local.get $wshift)) (i32.const 2)))))
                  (local.get $wshift))))))
        (local.set $wsum
          (i32.add
            (i32.add
              (i32.load (i32.add (local.get $errors1) (local.get $n)))
              (i32.load (i32.add (local.get $errors1) (local.get $ne))))
            (i32.load (i32.add (local.get $errors1) (local.get $nw)))))
        (if
          (i32.lt_u (local.get $wsum) (i32.const 2048))
          (then
            (local.set $w1
              (i32.load
                (i32.add (local.get $weights) (i32.shl (i32.add (local.get $wsum) (i32.const 0)) (i32.const 2))))))
          (else
            (local.set $wshift
              (select
                (i32.const 0)
                (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1))))
                (i32.gt_s
                  (i32.const 0)
                  (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1)))))))
            (local.set $w1
              (i32.add
                (i32.const 4)
                (i32.shr_s
                  (i32.mul
                    (i32.const 12)
                    (i32.load
                      (i32.add
                        (local.get $div)
                        (i32.shl (i32.shr_s (local.get $wsum) (local.get $wshift)) (i32.const 2)))))
                  (local.get $wshift))))))
        (local.set $wsum
          (i32.add
            (i32.add
              (i32.load (i32.add (local.get $errors2) (local.get $n)))
              (i32.load (i32.add (local.get $errors2) (local.get $ne))))
            (i32.load (i32.add (local.get $errors2) (local.get $nw)))))
        (if
          (i32.lt_u (local.get $wsum) (i32.const 2048))
          (then
            (local.set $w2
              (i32.load
                (i32.add (local.get $weights) (i32.shl (i32.add (local.get $wsum) (i32.const 0)) (i32.const 2))))))
          (else
            (local.set $wshift
              (select
                (i32.const 0)
                (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1))))
                (i32.gt_s
                  (i32.const 0)
                  (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1)))))))
            (local.set $w2
              (i32.add
                (i32.const 4)
                (i32.shr_s
                  (i32.mul
                    (i32.const 12)
                    (i32.load
                      (i32.add
                        (local.get $div)
                        (i32.shl (i32.shr_s (local.get $wsum) (local.get $wshift)) (i32.const 2)))))
                  (local.get $wshift))))))
        (local.set $wsum
          (i32.add
            (i32.add
              (i32.load (i32.add (local.get $errors3) (local.get $n)))
              (i32.load (i32.add (local.get $errors3) (local.get $ne))))
            (i32.load (i32.add (local.get $errors3) (local.get $nw)))))
        (if
          (i32.lt_u (local.get $wsum) (i32.const 2048))
          (then
            (local.set $w3
              (i32.load
                (i32.add (local.get $weights) (i32.shl (i32.add (local.get $wsum) (i32.const 0)) (i32.const 2))))))
          (else
            (local.set $wshift
              (select
                (i32.const 0)
                (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1))))
                (i32.gt_s
                  (i32.const 0)
                  (i32.sub (i32.const 26) (i32.clz (i32.add (local.get $wsum) (i32.const 1)))))))
            (local.set $w3
              (i32.add
                (i32.const 4)
                (i32.shr_s
                  (i32.mul
                    (i32.const 12)
                    (i32.load
                      (i32.add
                        (local.get $div)
                        (i32.shl (i32.shr_s (local.get $wsum) (local.get $wshift)) (i32.const 2)))))
                  (local.get $wshift))))))
        (local.set $N (i32.shl (local.get $top) (i32.const 3)))
        (local.set $W (i32.shl (local.get $left) (i32.const 3)))
        (local.set $NE (i32.shl (local.get $right) (i32.const 3)))
        (local.set $teW
          (if
            (result i32)
            (local.get $x)
            (then
              (i32.load
                (i32.sub
                  (i32.add (i32.add (local.get $error) (local.get $cur)) (i32.shl (local.get $x) (i32.const 2)))
                  (i32.const 4))))
            (else (i32.const 0))))
        (local.set $teN (i32.load (i32.add (local.get $error) (local.get $n))))
        (local.set $teNW (i32.load (i32.add (local.get $error) (local.get $nw))))
        (local.set $teNE (i32.load (i32.add (local.get $error) (local.get $ne))))
        (local.set $most (local.get $teW))
        (if
          (i32.gt_s
            (i32.sub
              (i32.xor (local.get $teN) (i32.shr_s (local.get $teN) (i32.const 31)))
              (i32.shr_s (local.get $teN) (i32.const 31)))
            (i32.sub
              (i32.xor (local.get $most) (i32.shr_s (local.get $most) (i32.const 31)))
              (i32.shr_s (local.get $most) (i32.const 31))))
          (then (local.set $most (local.get $teN))))
        (if
          (i32.gt_s
            (i32.sub
              (i32.xor (local.get $teNW) (i32.shr_s (local.get $teNW) (i32.const 31)))
              (i32.shr_s (local.get $teNW) (i32.const 31)))
            (i32.sub
              (i32.xor (local.get $most) (i32.shr_s (local.get $most) (i32.const 31)))
              (i32.shr_s (local.get $most) (i32.const 31))))
          (then (local.set $most (local.get $teNW))))
        (if
          (i32.gt_s
            (i32.sub
              (i32.xor (local.get $teNE) (i32.shr_s (local.get $teNE) (i32.const 31)))
              (i32.shr_s (local.get $teNE) (i32.const 31)))
            (i32.sub
              (i32.xor (local.get $most) (i32.shr_s (local.get $most) (i32.const 31)))
              (i32.shr_s (local.get $most) (i32.const 31))))
          (then (local.set $most (local.get $teNE))))
        (i32.store (local.get $properties) (local.get $most))
        (local.set $at
          (i32.add
            (local.get $bucket)
            (i32.shl
              (i32.add
                (select
                  (i32.const 501)
                  (select (i32.const -501) (local.get $most) (i32.gt_s (i32.const -501) (local.get $most)))
                  (i32.lt_s
                    (i32.const 501)
                    (select (i32.const -501) (local.get $most) (i32.gt_s (i32.const -501) (local.get $most)))))
                (i32.const 501))
              (i32.const 2))))
        (i32.store
          (local.get $contexts)
          (i32.load (i32.add (local.get $map) (i32.shl (i32.load (local.get $at)) (i32.const 2)))))
        (local.set $sumWN (i32.add (local.get $teW) (local.get $teN)))
        (local.set $p0 (i32.sub (i32.add (local.get $W) (local.get $NE)) (local.get $N)))
        (local.set $p1
          (i32.sub
            (local.get $N)
            (i32.shr_s (i32.mul (i32.add (local.get $sumWN) (local.get $teNE)) (i32.const 16)) (i32.const 5))))
        (local.set $p2
          (i32.sub
            (local.get $W)
            (i32.shr_s (i32.mul (i32.add (local.get $sumWN) (local.get $teNW)) (i32.const 10)) (i32.const 5))))
        (local.set $p3
          (i32.sub
            (local.get $N)
            (i32.shr_s
              (i32.mul (i32.add (i32.add (local.get $teNW) (local.get $teN)) (local.get $teNE)) (i32.const 7))
              (i32.const 5))))
        (local.set $shift
          (i32.sub
            (i32.const 27)
            (i32.clz
              (i32.add (i32.add (local.get $w0) (local.get $w1)) (i32.add (local.get $w2) (local.get $w3))))))
        (local.set $w0 (i32.shr_s (local.get $w0) (local.get $shift)))
        (local.set $w1 (i32.shr_s (local.get $w1) (local.get $shift)))
        (local.set $w2 (i32.shr_s (local.get $w2) (local.get $shift)))
        (local.set $w3 (i32.shr_s (local.get $w3) (local.get $shift)))
        (local.set $sum
          (i32.add (i32.add (local.get $w0) (local.get $w1)) (i32.add (local.get $w2) (local.get $w3))))
        (local.set $pred
          (i32.wrap_i64
            (i64.shr_s
              (i64.mul
                (i64.add
                  (i64.extend_i32_s (i32.sub (i32.shr_s (local.get $sum) (i32.const 1)) (i32.const 1)))
                  (i64.add
                    (i64.add
                      (i64.mul (i64.extend_i32_s (local.get $p0)) (i64.extend_i32_s (local.get $w0)))
                      (i64.mul (i64.extend_i32_s (local.get $p1)) (i64.extend_i32_s (local.get $w1))))
                    (i64.add
                      (i64.mul (i64.extend_i32_s (local.get $p2)) (i64.extend_i32_s (local.get $w2)))
                      (i64.mul (i64.extend_i32_s (local.get $p3)) (i64.extend_i32_s (local.get $w3))))))
                (i64.extend_i32_s
                  (i32.load
                    (i32.add (local.get $div) (i32.shl (i32.sub (local.get $sum) (i32.const 1)) (i32.const 2))))))
              (i64.const 24))))
        (if
          (i32.le_s
            (i32.or (i32.xor (local.get $teN) (local.get $teW)) (i32.xor (local.get $teN) (local.get $teNW)))
            (i32.const 0))
          (then
            (local.set $pred
              (select
                (select
                  (local.get $W)
                  (select (local.get $NE) (local.get $N) (i32.lt_s (local.get $NE) (local.get $N)))
                  (i32.lt_s
                    (local.get $W)
                    (select (local.get $NE) (local.get $N) (i32.lt_s (local.get $NE) (local.get $N)))))
                (select
                  (local.get $pred)
                  (select
                    (local.get $W)
                    (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))
                    (i32.gt_s
                      (local.get $W)
                      (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))))
                  (i32.lt_s
                    (local.get $pred)
                    (select
                      (local.get $W)
                      (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))
                      (i32.gt_s
                        (local.get $W)
                        (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))))))
                (i32.gt_s
                  (select
                    (local.get $W)
                    (select (local.get $NE) (local.get $N) (i32.lt_s (local.get $NE) (local.get $N)))
                    (i32.lt_s
                      (local.get $W)
                      (select (local.get $NE) (local.get $N) (i32.lt_s (local.get $NE) (local.get $N)))))
                  (select
                    (local.get $pred)
                    (select
                      (local.get $W)
                      (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))
                      (i32.gt_s
                        (local.get $W)
                        (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))))
                    (i32.lt_s
                      (local.get $pred)
                      (select
                        (local.get $W)
                        (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N)))
                        (i32.gt_s
                          (local.get $W)
                          (select (local.get $NE) (local.get $N) (i32.gt_s (local.get $NE) (local.get $N))))))))))))
        (local.set $value (i32.load (local.get $p)))
        (i32.store
          (local.get $out)
          (i32.xor
            (i32.shl
              (i32.sub
                (i32.sub (local.get $value) (i32.shr_s (i32.add (local.get $pred) (i32.const 3)) (i32.const 3)))
                (local.get $offset))
              (i32.const 1))
            (i32.shr_s
              (i32.sub
                (i32.sub (local.get $value) (i32.shr_s (i32.add (local.get $pred) (i32.const 3)) (i32.const 3)))
                (local.get $offset))
              (i32.const 31))))
        (local.set $v (i32.shl (local.get $value) (i32.const 3)))
        (local.set $at (i32.add (local.get $cur) (i32.shl (local.get $x) (i32.const 2))))
        (i32.store (i32.add (local.get $error) (local.get $at)) (i32.sub (local.get $pred) (local.get $v)))
        (local.set $e0
          (i32.shr_s
            (i32.add
              (i32.sub
                (i32.xor
                  (i32.sub (local.get $p0) (local.get $v))
                  (i32.shr_s (i32.sub (local.get $p0) (local.get $v)) (i32.const 31)))
                (i32.shr_s (i32.sub (local.get $p0) (local.get $v)) (i32.const 31)))
              (i32.const 3))
            (i32.const 3)))
        (i32.store (i32.add (local.get $errors0) (local.get $at)) (local.get $e0))
        (i32.store
          (i32.add (i32.add (local.get $errors0) (local.get $n)) (i32.const 4))
          (i32.add
            (i32.load (i32.add (i32.add (local.get $errors0) (local.get $n)) (i32.const 4)))
            (local.get $e0)))
        (local.set $e1
          (i32.shr_s
            (i32.add
              (i32.sub
                (i32.xor
                  (i32.sub (local.get $p1) (local.get $v))
                  (i32.shr_s (i32.sub (local.get $p1) (local.get $v)) (i32.const 31)))
                (i32.shr_s (i32.sub (local.get $p1) (local.get $v)) (i32.const 31)))
              (i32.const 3))
            (i32.const 3)))
        (i32.store (i32.add (local.get $errors1) (local.get $at)) (local.get $e1))
        (i32.store
          (i32.add (i32.add (local.get $errors1) (local.get $n)) (i32.const 4))
          (i32.add
            (i32.load (i32.add (i32.add (local.get $errors1) (local.get $n)) (i32.const 4)))
            (local.get $e1)))
        (local.set $e2
          (i32.shr_s
            (i32.add
              (i32.sub
                (i32.xor
                  (i32.sub (local.get $p2) (local.get $v))
                  (i32.shr_s (i32.sub (local.get $p2) (local.get $v)) (i32.const 31)))
                (i32.shr_s (i32.sub (local.get $p2) (local.get $v)) (i32.const 31)))
              (i32.const 3))
            (i32.const 3)))
        (i32.store (i32.add (local.get $errors2) (local.get $at)) (local.get $e2))
        (i32.store
          (i32.add (i32.add (local.get $errors2) (local.get $n)) (i32.const 4))
          (i32.add
            (i32.load (i32.add (i32.add (local.get $errors2) (local.get $n)) (i32.const 4)))
            (local.get $e2)))
        (local.set $e3
          (i32.shr_s
            (i32.add
              (i32.sub
                (i32.xor
                  (i32.sub (local.get $p3) (local.get $v))
                  (i32.shr_s (i32.sub (local.get $p3) (local.get $v)) (i32.const 31)))
                (i32.shr_s (i32.sub (local.get $p3) (local.get $v)) (i32.const 31)))
              (i32.const 3))
            (i32.const 3)))
        (i32.store (i32.add (local.get $errors3) (local.get $at)) (local.get $e3))
        (i32.store
          (i32.add (i32.add (local.get $errors3) (local.get $n)) (i32.const 4))
          (i32.add
            (i32.load (i32.add (i32.add (local.get $errors3) (local.get $n)) (i32.const 4)))
            (local.get $e3)))
        (local.set $p (i32.add (local.get $p) (i32.const 4)))
        (local.set $out (i32.add (local.get $out) (i32.const 4)))
        (local.set $properties (i32.add (local.get $properties) (i32.const 4)))
        (local.set $contexts (i32.add (local.get $contexts) (i32.const 4)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br_if $xs (i32.lt_u (local.get $x) (local.get $width))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br_if $ys (i32.lt_u (local.get $y) (local.get $height)))))
  ;; A match can overlap its source. Every compared lane remains inside the plane.
  (func $screenSpan (param $a i32) (param $b i32) (param $limit i32) (result i32)
    (local $k i32) (local $mask i32)
    (block $tail
      (loop $four
        (br_if $tail (i32.gt_u (i32.add (local.get $k) (i32.const 4)) (local.get $limit)))
        (if (i32.ne (i32.load offset=0 (local.get $a)) (i32.load offset=0 (local.get $b)))
          (then (return (i32.add (local.get $k) (i32.const 0)))))
        (if (i32.ne (i32.load offset=4 (local.get $a)) (i32.load offset=4 (local.get $b)))
          (then (return (i32.add (local.get $k) (i32.const 1)))))
        (if (i32.ne (i32.load offset=8 (local.get $a)) (i32.load offset=8 (local.get $b)))
          (then (return (i32.add (local.get $k) (i32.const 2)))))
        (if (i32.ne (i32.load offset=12 (local.get $a)) (i32.load offset=12 (local.get $b)))
          (then (return (i32.add (local.get $k) (i32.const 3)))))
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

)
