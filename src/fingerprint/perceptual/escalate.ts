/**
 * Phase 3 — Escalated scoring using perceptual signals.
 *
 * Called by Phase 2's scorer when L1–L3 signals disagree.
 * Runs frameHashes + audioFingerprint, compares against a prior
 * PerceptualFingerprint, and returns a structured verdict.
 */

import { frameHashes, hammingDistance } from "./frames.js";
import { audioFingerprint, audioCorrelation } from "./audio.js";
import type {
  PerceptualFingerprint,
  EscalationVerdict,
  SignalVerdict,
} from "./types.js";

// ---------------------------------------------------------------------------
// Thresholds (from plan)
// ---------------------------------------------------------------------------

const FRAME_MATCH_THRESHOLD = 8;  // per-frame Hamming ≤8 → match
const FRAME_NEAR_THRESHOLD = 16;  // per-frame Hamming ≤16 → near
const AUDIO_MATCH_THRESHOLD = 0.95;
const AUDIO_NEAR_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// Frame verdict helpers
// ---------------------------------------------------------------------------

function frameVerdictFromHashes(
  current: readonly string[],
  prior: readonly string[]
): SignalVerdict {
  const len = Math.min(current.length, prior.length);
  if (len === 0) return "unknown";

  let totalDist = 0;
  let maxDist = 0;

  for (let i = 0; i < len; i++) {
    const d = hammingDistance(current[i], prior[i]);
    totalDist += d;
    if (d > maxDist) maxDist = d;
  }

  const avgDist = totalDist / len;

  // If any frame differs wildly, treat as mismatch
  if (maxDist > FRAME_NEAR_THRESHOLD * 2) return "mismatch";
  if (avgDist <= FRAME_MATCH_THRESHOLD) return "match";
  if (avgDist <= FRAME_NEAR_THRESHOLD) return "near";
  return "mismatch";
}

function audioVerdictFromCorrelation(correlation: number): SignalVerdict {
  if (correlation >= AUDIO_MATCH_THRESHOLD) return "match";
  if (correlation >= AUDIO_NEAR_THRESHOLD) return "near";
  return "mismatch";
}

function verdictToScore(
  verdict: SignalVerdict,
  matchScore: number,
  nearScore: number
): number {
  if (verdict === "match") return matchScore;
  if (verdict === "near") return nearScore;
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run perceptual escalation for a video and compare against a prior fingerprint.
 *
 * Phase 2's scorer should call this when L1–L3 signals disagree:
 *
 *   ```ts
 *   import { escalatedScore } from "./perceptual/index.js";
 *   const verdict = await escalatedScore(videoPath, priorPerceptual, durationMs);
 *   if (verdict.perceptualScore >= 4) { // treat as UNCHANGED }
 *   ```
 *
 * @param videoPath   Absolute path to the video file being evaluated.
 * @param prior       Previously stored PerceptualFingerprint (or null if first run).
 * @param durationMs  Video duration in milliseconds (from ffprobe L2).
 */
export async function escalatedScore(
  videoPath: string,
  prior: PerceptualFingerprint | null,
  durationMs: number
): Promise<EscalationVerdict> {
  const [currentFrames, currentAudio] = await Promise.all([
    frameHashes(videoPath, durationMs),
    audioFingerprint(videoPath, durationMs),
  ]);

  // --- Frame verdict ---
  let frameVerdict: SignalVerdict = "unknown";
  if (currentFrames !== null && prior?.frames != null) {
    frameVerdict = frameVerdictFromHashes(
      currentFrames.hashes,
      prior.frames.hashes
    );
  } else if (currentFrames === null) {
    frameVerdict = "unknown";
  }

  // --- Audio verdict ---
  let audioVerdict: SignalVerdict = "unknown";
  if (currentAudio !== null && prior?.audio != null) {
    const corr = audioCorrelation(
      currentAudio.fingerprint,
      prior.audio.fingerprint
    );
    audioVerdict = audioVerdictFromCorrelation(corr);
  } else if (currentAudio === null) {
    audioVerdict = "unknown";
  }

  // --- Composite score (max = 5: frame match=2 + audio match=3) ---
  const perceptualScore =
    verdictToScore(frameVerdict, 2, 1) +
    verdictToScore(audioVerdict, 3, 1);

  return { frameVerdict, audioVerdict, perceptualScore };
}
