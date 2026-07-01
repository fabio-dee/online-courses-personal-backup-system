import { describe, it, expect } from 'vitest';
import { scoreVideo, scoreBody } from '../score.js';
import type { FullFingerprint } from '../types.js';

function makeFingerprint(overrides: Partial<FullFingerprint> = {}): FullFingerprint {
    return {
        fp_schema: 2,
        playbackId: 'abc123',
        ffprobe: {
            durationMs: 60_000,
            nbStreams: 2,
            videoCodec: 'h264',
            audioCodec: 'aac',
            width: 1920,
            height: 1080,
            bitRate: 2_000_000,
        },
        chunks: {
            first: 'aaaa',
            middle: 'bbbb',
            last: 'cccc',
            fileSize: 10_000_000,
        },
        bodyHash: 'deadbeef',
        ...overrides,
    };
}

describe('scoreVideo', () => {
    it('identical fingerprints → UNCHANGED', () => {
        const result = scoreVideo(makeFingerprint(), makeFingerprint());
        expect(result.state).toBe('UNCHANGED');
    });

    it('duration off 50ms → UNCHANGED', () => {
        const prior = makeFingerprint();
        const current = makeFingerprint({
            ffprobe: { ...prior.ffprobe!, durationMs: 60_050 },
        });
        expect(scoreVideo(prior, current).state).toBe('UNCHANGED');
    });

    it('duration off 1500ms → UNCHANGED', () => {
        const prior = makeFingerprint();
        const current = makeFingerprint({
            ffprobe: { ...prior.ffprobe!, durationMs: 61_500 },
        });
        expect(scoreVideo(prior, current).state).toBe('UNCHANGED');
    });

    it('duration off 10s → REPLACED', () => {
        const prior = makeFingerprint();
        const current = makeFingerprint({
            ffprobe: { ...prior.ffprobe!, durationMs: 70_000 },
        });
        expect(scoreVideo(prior, current).state).toBe('REPLACED');
    });

    it('playback mismatch is not enough by itself to overpower local chunk matches', () => {
        // The update pipeline must compare remote lightweight fingerprints before
        // calling scoreVideo. scoreVideo mostly judges local-file similarity, so a
        // remote playbackId mismatch can otherwise be masked by unchanged local chunks.
        const prior = makeFingerprint({ playbackId: 'old-playback' });
        const current = makeFingerprint({ playbackId: 'new-playback' });
        expect(scoreVideo(prior, current).state).toBe('UNCHANGED');
    });

    it('ffprobe null on prior → UNKNOWN', () => {
        const prior = makeFingerprint({ ffprobe: null });
        expect(scoreVideo(prior, makeFingerprint()).state).toBe('UNKNOWN');
    });

    it('chunk hashes differ, duration & playback match → MINOR_CHANGE', () => {
        const prior = makeFingerprint();
        const current = makeFingerprint({
            chunks: { first: 'xxxx', middle: 'yyyy', last: 'zzzz', fileSize: 10_000_000 },
        });
        expect(scoreVideo(prior, current).state).toBe('MINOR_CHANGE');
    });
});

describe('scoreBody', () => {
    it('identical hashes → UNCHANGED', () => {
        expect(scoreBody('abc', 'abc')).toBe('UNCHANGED');
    });

    it('different hashes → MINOR', () => {
        expect(scoreBody('abc', 'def')).toBe('MINOR');
    });

    it('null on either side → UNCHANGED (P0-1: avoid false MINOR when index.html unavailable)', () => {
        // null means the HTML was unavailable during offline rebuild; treat as UNCHANGED
        // so we don't flag a false-positive body change.
        expect(scoreBody(null, 'abc')).toBe('UNCHANGED');
        expect(scoreBody('abc', null)).toBe('UNCHANGED');
        expect(scoreBody(null, null)).toBe('UNCHANGED');
    });
});
