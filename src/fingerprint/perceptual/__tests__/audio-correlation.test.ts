/**
 * audioCorrelation unit tests — no fpcalc required.
 */

import { describe, it, expect } from "vitest";
import { audioCorrelation } from "../audio.js";

function makeFingerprint(len: number, seed: number): number[] {
  const arr: number[] = [];
  let x = seed;
  for (let i = 0; i < len; i++) {
    // Simple LCG for deterministic pseudorandom int32
    x = (Math.imul(x, 1664525) + 1013904223) | 0;
    arr.push(x);
  }
  return arr;
}

describe("audioCorrelation", () => {
  it("identical arrays → correlation ≈ 1.0", () => {
    const fp = makeFingerprint(200, 42);
    expect(audioCorrelation(fp, fp)).toBeCloseTo(1.0, 10);
  });

  it("bitwise-inverted arrays → correlation ≈ 0.0", () => {
    const fp = makeFingerprint(200, 99);
    const inv = fp.map((n) => ~n);
    expect(audioCorrelation(fp, inv)).toBeCloseTo(0.0, 10);
  });

  it("empty arrays → 0", () => {
    expect(audioCorrelation([], [])).toBe(0);
  });

  it("different lengths → uses overlap window", () => {
    const a = makeFingerprint(100, 7);
    const b = [...a, ...makeFingerprint(50, 999)]; // b is longer
    // Only first 100 elements used
    const corr = audioCorrelation(a, b);
    expect(corr).toBeCloseTo(1.0, 10);
  });

  it("randomly different arrays produce intermediate correlation", () => {
    const a = makeFingerprint(500, 1);
    const b = makeFingerprint(500, 2); // different seed → different values
    const corr = audioCorrelation(a, b);
    // Should be around 0.5 for random uncorrelated int32s (each bit ~50/50)
    expect(corr).toBeGreaterThan(0.3);
    expect(corr).toBeLessThan(0.7);
  });

  it("partial overlap (one int32 shared): correlation exactly 1.0 for that window", () => {
    const a = [0x12345678];
    const b = [0x12345678];
    expect(audioCorrelation(a, b)).toBeCloseTo(1.0, 10);
  });
});
