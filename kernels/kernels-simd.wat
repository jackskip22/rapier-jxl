;; SPDX-License-Identifier: MIT
;; Own bounded integer kernels. Pointers and lengths are checked by kernels.mjs.
;; Tiny arithmetic helpers are explicitly inlined: Node 22 does not inline WAT calls
;; by default. i64 multiplication followed by arithmetic >>24 is floor, not truncation.
;; SIMD averages add one to negative sums before >>1, matching JavaScript's /2 |0.
(module
  (import "env" "memory" (memory 1 128))
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
        (br_if $next (i32.lt_u (local.get $i) (local.get $n)))))))
