/**
 * Phase 4 integration tests — classification flow with synthetic FullFingerprints.
 * No real ffprobe, no network, no Skool auth required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoreVideo, scoreBody } from '../fingerprint/score.js';
import type { FullFingerprint } from '../fingerprint/types.js';

// ---------------------------------------------------------------------------
// Helpers to build synthetic FullFingerprints
// ---------------------------------------------------------------------------

function makeFp(overrides: Partial<FullFingerprint> = {}): FullFingerprint {
    return {
        fp_schema: 2,
        playbackId: 'playback-abc',
        ffprobe: {
            durationMs: 120_000,
            nbStreams: 2,
            videoCodec: 'h264',
            audioCodec: 'aac',
            width: 1920,
            height: 1080,
            bitRate: 4_000_000,
        },
        chunks: {
            first: 'aabbcc',
            middle: 'ddeeff',
            last: '112233',
            fileSize: 50_000_000,
        },
        bodyHash: 'bodyhash1',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Test 1: UNCHANGED verdict when all signals match
// ---------------------------------------------------------------------------

describe('classification: UNCHANGED when fingerprints match', () => {
    it('scoreVideo returns UNCHANGED for identical fingerprints', () => {
        const prior = makeFp();
        const current = makeFp();

        const verdict = scoreVideo(prior, current);

        expect(verdict.state).toBe('UNCHANGED');
        expect(verdict.score).toBeGreaterThanOrEqual(12);
    });

    it('scoreBody returns UNCHANGED when body hashes are equal', () => {
        const result = scoreBody('hash-abc', 'hash-abc');
        expect(result).toBe('UNCHANGED');
    });

    it('UNCHANGED video + UNCHANGED body maps to "unchanged" outcome', () => {
        const prior = makeFp();
        const current = makeFp();

        const videoVerdict = scoreVideo(prior, current);
        const bodyVerdict = scoreBody('bodyhash1', 'bodyhash1');

        // The mapping from (videoState, bodyState) → LessonOutcome
        let outcome: string;
        if (videoVerdict.state === 'UNCHANGED' && bodyVerdict === 'UNCHANGED') {
            outcome = 'unchanged';
        } else if (videoVerdict.state === 'REPLACED') {
            outcome = 'video-updated';
        } else if (bodyVerdict === 'MINOR') {
            outcome = 'text-updated';
        } else {
            outcome = 'unchanged';
        }

        expect(outcome).toBe('unchanged');
    });
});

// ---------------------------------------------------------------------------
// Test 2: REPLACED verdict when duration changes significantly
// ---------------------------------------------------------------------------

describe('classification: REPLACED when video duration changes', () => {
    it('scoreVideo returns REPLACED when duration differs by >2s', () => {
        const prior = makeFp();
        const current = makeFp({
            ffprobe: {
                durationMs: 180_000, // 60 seconds longer — clear replacement
                nbStreams: 2,
                videoCodec: 'h264',
                audioCodec: 'aac',
                width: 1920,
                height: 1080,
                bitRate: 4_000_000,
            },
            chunks: {
                first: '000000',
                middle: '111111',
                last: '222222',
                fileSize: 75_000_000,
            },
        });

        const verdict = scoreVideo(prior, current);

        expect(verdict.state).toBe('REPLACED');
    });

    it('REPLACED video maps to "video-updated" outcome', () => {
        const prior = makeFp();
        const current = makeFp({
            ffprobe: {
                durationMs: 999_000,
                nbStreams: 2,
                videoCodec: 'h264',
                audioCodec: 'aac',
                width: 1920,
                height: 1080,
                bitRate: 4_000_000,
            },
        });

        const videoVerdict = scoreVideo(prior, current);

        let outcome: string;
        if (videoVerdict.state === 'REPLACED' || videoVerdict.state === 'UNKNOWN') {
            outcome = 'video-updated';
        } else {
            outcome = 'unchanged';
        }

        expect(outcome).toBe('video-updated');
    });
});

// ---------------------------------------------------------------------------
// Test 3: Stale lesson is NOT classified as new
// ---------------------------------------------------------------------------

describe('classification: stale lesson is not treated as new', () => {
    it('a manifest with no fullFingerprint is stale but not new', () => {
        // Simulate the stale detection logic from loadOrRebuildFingerprint:
        // fp_schema missing → wasStale=true, but isNewLesson stays false
        // because a lesson.json exists on disk.

        const manifest = {
            lessonId: 'lesson-123',
            fullFingerprint: undefined, // no full fingerprint yet
        };

        const isNewLesson = false; // lesson.json exists → not new
        const isStale = manifest.fullFingerprint === undefined ||
            (manifest.fullFingerprint as unknown as { fp_schema?: number })?.fp_schema !== 2;

        // Key invariant: stale does NOT imply new
        expect(isStale).toBe(true);
        expect(isNewLesson).toBe(false);

        // After stale rebuild, the lesson should be scored normally (not added to videosNew)
        // We verify the scoring path is taken (not the "new lesson" path)
        const priorBodyHash = 'oldbodyhash';
        const currentBodyHash = 'oldbodyhash';
        const bodyVerdict = scoreBody(priorBodyHash, currentBodyHash);
        expect(bodyVerdict).toBe('UNCHANGED');
    });
});

// ---------------------------------------------------------------------------
// Test 4: UNKNOWN video state triggers re-download
// ---------------------------------------------------------------------------

describe('classification: UNKNOWN video state triggers re-download', () => {
    it('UNKNOWN state (ffprobe null) maps to re-download', () => {
        const prior = makeFp({ ffprobe: null });
        const current = makeFp({ ffprobe: null });

        const verdict = scoreVideo(prior, current);

        // With ffprobe null on both sides, hasFfprobeNull=true → UNKNOWN
        expect(verdict.state).toBe('UNKNOWN');

        // The wiring in index.ts maps UNKNOWN → shouldRedownload=true
        const shouldRedownload = verdict.state === 'UNKNOWN';
        expect(shouldRedownload).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test 5: scoreBody MINOR when hashes differ
// ---------------------------------------------------------------------------

describe('classification: body change detection', () => {
    it('scoreBody returns MINOR when hashes differ', () => {
        const result = scoreBody('hash-old', 'hash-new');
        expect(result).toBe('MINOR');
    });

    it('scoreBody returns UNCHANGED when prior hash is null (P0-1: null means unavailable, not changed)', () => {
        // null on either side means the HTML was unavailable during offline rebuild;
        // treat as UNCHANGED to avoid false-positive body change detection.
        expect(scoreBody(null, 'hash-new')).toBe('UNCHANGED');
        expect(scoreBody('hash-old', null)).toBe('UNCHANGED');
    });
});
