/**
 * dhash64 unit tests — no ffmpeg required.
 */

import { describe, it, expect } from "vitest";
import { dhash64, hammingDistance } from "../frames.js";

function makeGrayscale(width: number, height: number, fill: number): Buffer {
  return Buffer.alloc(width * height, fill);
}

describe("dhash64", () => {
  it("returns a 16-char hex string for a valid 9x8 buffer", () => {
    const buf = makeGrayscale(9, 8, 128);
    const hash = dhash64(buf);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it("returns zero hash for a uniform grey image (all cols equal)", () => {
    // Uniform buffer: every adjacent pair is equal → no bits set
    const buf = makeGrayscale(9, 8, 200);
    const hash = dhash64(buf);
    expect(hash).toBe("0000000000000000");
  });

  it("identical buffers produce Hamming distance 0", () => {
    const buf = Buffer.alloc(72);
    for (let i = 0; i < 72; i++) buf[i] = (i * 37) % 256;
    const h = dhash64(buf);
    expect(hammingDistance(h, h)).toBe(0);
  });

  it("horizontally-flipped checkerboard produces non-zero Hamming distance", () => {
    // Checkerboard: alternating 0/255 per column in each row
    // dhash compares adjacent columns → alternating 0/1 bits
    const a = Buffer.alloc(72);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        a[row * 9 + col] = col % 2 === 0 ? 0 : 255;
      }
    }
    // Inverted-phase checkerboard: 255/0 per column
    // Every adjacent pair direction is reversed → all 64 bits flip
    const b = Buffer.alloc(72);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        b[row * 9 + col] = col % 2 === 0 ? 255 : 0;
      }
    }
    const ha = dhash64(a);
    const hb = dhash64(b);
    const dist = hammingDistance(ha, hb);

    // Phase-inverted checkerboard flips every comparison → distance = 64
    expect(dist).toBe(64);
  });

  it("fully inverted buffer produces maximum Hamming distance", () => {
    // Ascending gradient → all pairs go left < right → all bits = 0
    const a = Buffer.alloc(72);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        a[row * 9 + col] = col * 28; // ascending
      }
    }
    // Descending gradient → all pairs go left > right → all bits = 1
    const b = Buffer.alloc(72);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        b[row * 9 + col] = (8 - col) * 28; // descending
      }
    }
    const ha = dhash64(a);
    const hb = dhash64(b);
    const dist = hammingDistance(ha, hb);
    expect(dist).toBe(64);
  });

  it("throws on wrong buffer size", () => {
    const buf = Buffer.alloc(50);
    expect(() => dhash64(buf)).toThrow();
  });
});

describe("hammingDistance", () => {
  it("same string → 0", () => {
    expect(hammingDistance("abcdef0123456789", "abcdef0123456789")).toBe(0);
  });

  it("all-zeros vs all-ones → 64", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("throws on wrong length", () => {
    expect(() => hammingDistance("abc", "def")).toThrow();
  });
});
