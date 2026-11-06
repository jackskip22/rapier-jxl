// SPDX-License-Identifier: MIT
import {exactTan, exactSin, exactCos, exactExp, EXACT_PI} from './exact-math.mjs';

export function recursiveGaussian(sigma) {
  const radius = Math.round(3.2795 * sigma + 0.2546), p = EXACT_PI / (2 * radius), omega = [p, 3 * p, 5 * p];
  const p1 = 1 / exactTan(0.5 * omega[0]), p3 = -1 / exactTan(0.5 * omega[1]), p5 = 1 / exactTan(0.5 * omega[2]);
  const r1 = p1 * p1 / exactSin(omega[0]), r3 = -p3 * p3 / exactSin(omega[1]), r5 = p5 * p5 / exactSin(omega[2]);
  const rho = omega.map(w => exactExp(-0.5 * sigma * sigma * w * w) / radius);
  const d13 = p1 * r3 - r1 * p3, d35 = p3 * r5 - r3 * p5, d51 = p5 * r1 - r5 * p1;
  const z15 = d35 / d13, z35 = d51 / d13;
  const A = [p1, p3, p5, r1, r3, r5, z15, z35, 1], gamma = [1, radius * radius - sigma * sigma, z15 * rho[0] + z35 * rho[1] + rho[2]];
  const inv = invert3(A), beta = [0, 1, 2].map(i => inv[i * 3] * gamma[0] + inv[i * 3 + 1] * gamma[1] + inv[i * 3 + 2] * gamma[2]);
  return {radius, n2: omega.map((w, i) => -beta[i] * exactCos(w * (radius + 1))), d1: omega.map(w => -2 * exactCos(w))};
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export {GAUSS} from './ssimulacra2-constants.mjs';


export function gaussianTaps(g = recursiveGaussian(1.5)) {
  const size = 4*g.radius+1, line = new Float64Array(size), out = new Float64Array(size);
  line[2*g.radius]=1; response(line,out,size,g);
  return Float64Array.from({length:2*g.radius-1},(_,i)=>out[g.radius+1+i]);
}
function response(input,out,count,g) {
  const N=g.radius,[n1,n3,n5]=g.n2,[d1,d3,d5]=g.d1;
  let a1=0,b1=0,a3=0,b3=0,a5=0,b5=0;
  for(let n=-N+1;n<count;n++){
    const left=n-N-1,right=n+N-1,sum=(left>=0?input[left]:0)+(right<count?input[right]:0);
    const o1=n1*sum-d1*a1-b1,o3=n3*sum-d3*a3-b3,o5=n5*sum-d5*a5-b5;
    b1=a1;a1=o1;b3=a3;a3=o3;b5=a5;a5=o5;if(n>=0)out[n]=o1+o3+o5;
  }
}
