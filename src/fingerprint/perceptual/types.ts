/**
 * Phase 3 — Perceptual fingerprint types.
 * These are consumed lazily by Phase 2's scorer (escalate.ts).
 */

/** Result of perceptual frame hashing via dhash64. */
export interface FrameHashes {
  /** 5 hex strings, each 16 chars (64-bit dhash). Indices: t=10/30/50/70/90%. */
  hashes: [string, string, string, string, string];
  algo: "dhash64";
}

/** Result of chromaprint audio fingerprinting via fpcalc. */
export interface AudioFingerprint {
  /** Raw int32 fingerprint array from fpcalc. */
  fingerprint: number[];
  /** Duration in seconds as reported by fpcalc. */
  duration: number;
}

/** Union of available perceptual signals for a single lesson video. */
export interface PerceptualFingerprint {
  frames: FrameHashes | null;
  audio: AudioFingerprint | null;
}

/** Per-signal verdict from the escalation step. */
export type SignalVerdict = "match" | "near" | "mismatch" | "unknown";

/** Output of escalatedScore — used by Phase 2's scorer when L1–L3 disagree. */
export interface EscalationVerdict {
  /** Frame-level verdict across 5 sampled frames. */
  frameVerdict: SignalVerdict;
  /** Audio correlation verdict. */
  audioVerdict: SignalVerdict;
  /**
   * Composite perceptual score:
   *  - frameVerdict match=2, near=1, mismatch=0, unknown=0
   *  - audioVerdict match=3, near=1, mismatch=0, unknown=0
   * Max = 5.
   */
  perceptualScore: number;
}
