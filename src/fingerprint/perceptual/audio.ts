/**
 * Phase 3 — Audio fingerprint via fpcalc (chromaprint).
 *
 * fpcalc availability is detected once at module load and cached.
 * If fpcalc is absent, all calls return null gracefully.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioFingerprint } from "./types.js";

const execFileAsync = promisify(execFile);
const FPCALC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// fpcalc availability — detected once, cached as a Promise<boolean>
// ---------------------------------------------------------------------------

let _fpcalcAvailablePromise: Promise<boolean> | null = null;

function fpcalcAvailable(): Promise<boolean> {
  if (_fpcalcAvailablePromise === null) {
    _fpcalcAvailablePromise = execFileAsync("which", ["fpcalc"])
      .then(() => true)
      .catch(() => false);
  }
  return _fpcalcAvailablePromise;
}

// ---------------------------------------------------------------------------
// Pure correlation function
// ---------------------------------------------------------------------------

/**
 * Compute Hamming-distance–based correlation between two chromaprint fingerprints.
 *
 * Each fingerprint is an array of int32 values. Similarity is computed over
 * the overlapping window: for each pair of int32s, count matching bits out of
 * 32. Overall score = matching_bits / total_bits ∈ [0, 1].
 */
export function audioCorrelation(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let matchingBits = 0;
  const totalBits = len * 32;

  for (let i = 0; i < len; i++) {
    // XOR gives differing bits; popcount those, subtract from 32 to get matches
    let xor = ((a[i] ^ b[i]) >>> 0) & 0xffffffff;
    let diffBits = 0;
    while (xor !== 0) {
      diffBits += xor & 1;
      xor = xor >>> 1;
    }
    matchingBits += 32 - diffBits;
  }

  return matchingBits / totalBits;
}

// ---------------------------------------------------------------------------
// fpcalc parsing
// ---------------------------------------------------------------------------

interface FpcalcOutput {
  duration: number;
  fingerprint: number[];
}

function parseFpcalcOutput(stdout: string): FpcalcOutput | null {
  const durationMatch = stdout.match(/^DURATION=(.+)$/m);
  const fingerprintMatch = stdout.match(/^FINGERPRINT=(.+)$/m);
  if (!durationMatch || !fingerprintMatch) return null;

  const duration = parseFloat(durationMatch[1]);
  const fingerprint = fingerprintMatch[1]
    .trim()
    .split(",")
    .map((s) => parseInt(s, 10));

  if (isNaN(duration) || fingerprint.some((n) => isNaN(n))) return null;
  return { duration, fingerprint };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an audio fingerprint for the "middle" of a video (skip first+last 10%).
 * Shells out to `fpcalc -length 120 -raw`.
 * Returns null if fpcalc is not installed or on any error/timeout.
 */
export async function audioFingerprint(
  videoPath: string,
  durationMs: number
): Promise<AudioFingerprint | null> {
  if (!(await fpcalcAvailable())) return null;

  const durationSec = durationMs / 1000;
  const skipStart = durationSec * 0.1;
  // fpcalc offset flag: -offset <seconds>
  const lengthSec = Math.min(120, durationSec * 0.8);

  if (lengthSec < 5) return null; // too short to fingerprint meaningfully

  return new Promise((resolve) => {
    const args = [
      "-length", String(Math.floor(lengthSec)),
      "-offset", String(Math.floor(skipStart)),
      "-raw",
      videoPath,
    ];

    const child = spawn("fpcalc", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, FPCALC_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const parsed = parseFpcalcOutput(stdout);
      if (!parsed) {
        resolve(null);
        return;
      }
      resolve({ fingerprint: parsed.fingerprint, duration: parsed.duration });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
