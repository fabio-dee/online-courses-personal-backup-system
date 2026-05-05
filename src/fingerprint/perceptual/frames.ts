/**
 * Phase 3 — Perceptual frame hashes via dhash64.
 *
 * Approach: ffmpeg filter-only — no JS image library needed.
 * We use `-vf scale=9:8,format=gray` so ffmpeg delivers raw 8-bit 9×8 pixels
 * via `-f rawvideo`. dhash then compares adjacent columns in each row (8 rows
 * × 8 comparisons = 64 bits). This avoids pngjs/sharp entirely.
 */

import { spawn } from "node:child_process";
import type { FrameHashes } from "./types.js";

const FRAME_OFFSETS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
const FFMPEG_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// dhash64 — pure TypeScript, operates on a 9×8 grayscale Buffer
// ---------------------------------------------------------------------------

/**
 * Compute a 64-bit difference hash (dhash) from a 9×8 grayscale pixel buffer.
 * Layout: row-major, 72 bytes total (width=9, height=8).
 * For each of 8 rows, compare pixel[col] vs pixel[col+1] for col=0..7.
 * Bit is set if left > right. Output: 16-char hex string.
 */
export function dhash64(pixels: Buffer): string {
  if (pixels.length !== 72) {
    throw new Error(`dhash64: expected 72 bytes, got ${pixels.length}`);
  }
  let lo = 0;
  let hi = 0;
  let bit = 0;
  for (let row = 0; row < 8; row++) {
    const base = row * 9;
    for (let col = 0; col < 8; col++) {
      const diff = pixels[base + col] > pixels[base + col + 1] ? 1 : 0;
      if (bit < 32) {
        lo |= diff << bit;
      } else {
        hi |= diff << (bit - 32);
      }
      bit++;
    }
  }
  const toHex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return toHex8(hi) + toHex8(lo);
}

/**
 * Hamming distance between two 16-char hex fingerprints (64-bit dhash).
 * Returns the number of differing bits (0–64).
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) {
    throw new Error("hammingDistance: expected 16-char hex strings");
  }
  let dist = 0;
  for (let i = 0; i < 4; i++) {
    const wa = parseInt(a.slice(i * 4, i * 4 + 4), 16);
    const wb = parseInt(b.slice(i * 4, i * 4 + 4), 16);
    let xor = (wa ^ wb) & 0xffff;
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/**
 * Extract a single 9×8 raw grayscale frame at seekTime seconds via ffmpeg.
 * Returns 72 bytes or null on failure.
 */
function extractRawFrame(
  videoPath: string,
  seekTimeSec: number
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      "-ss", String(seekTimeSec),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=9:8,format=gray",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "pipe:1",
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (d: Buffer) => chunks.push(d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, FFMPEG_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const raw = Buffer.concat(chunks);
      resolve(raw.length >= 72 ? raw.subarray(0, 72) : null);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract 5 perceptual frame hashes at t = 10/30/50/70/90% of duration.
 * Returns null on any ffmpeg failure or timeout.
 */
export async function frameHashes(
  videoPath: string,
  durationMs: number
): Promise<FrameHashes | null> {
  const durationSec = durationMs / 1000;
  const results: string[] = [];

  for (const offset of FRAME_OFFSETS) {
    const t = durationSec * offset;
    const raw = await extractRawFrame(videoPath, t);
    if (raw === null) return null;
    results.push(dhash64(raw));
  }

  return {
    hashes: results as [string, string, string, string, string],
    algo: "dhash64",
  };
}
