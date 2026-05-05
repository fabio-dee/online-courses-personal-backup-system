/**
 * Unit tests for score.ts — runnable with: npx tsx src/fingerprint/__tests__/score.test.ts
 */
import assert from 'assert';
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

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err instanceof Error ? err.message : String(err)}`);
        failed++;
    }
}

// 1. Identical fingerprints → UNCHANGED
test('identical fingerprints → UNCHANGED', () => {
    const fp = makeFingerprint();
    const result = scoreVideo(fp, makeFingerprint());
    assert.strictEqual(result.state, 'UNCHANGED', `Got ${result.state}, score=${result.score}`);
});

// 2. Duration off by 50ms → UNCHANGED (within match threshold)
test('duration off 50ms → UNCHANGED', () => {
    const prior = makeFingerprint();
    const current = makeFingerprint({
        ffprobe: { ...prior.ffprobe!, durationMs: 60_050 },
    });
    const result = scoreVideo(prior, current);
    assert.strictEqual(result.state, 'UNCHANGED', `Got ${result.state}, score=${result.score}`);
});

// 3. Duration off by 1.5s → UNCHANGED (near + chunk match gives enough score)
test('duration off 1500ms → UNCHANGED', () => {
    const prior = makeFingerprint();
    const current = makeFingerprint({
        ffprobe: { ...prior.ffprobe!, durationMs: 61_500 },
    });
    const result = scoreVideo(prior, current);
    // near duration (weight 2) + playback match (2) + codec match (1) + 3 chunks (9) = 14 ≥ 8
    assert.strictEqual(result.state, 'UNCHANGED', `Got ${result.state}, score=${result.score}`);
});

// 4. Duration off by 10s → REPLACED
test('duration off 10s → REPLACED', () => {
    const prior = makeFingerprint();
    const current = makeFingerprint({
        ffprobe: { ...prior.ffprobe!, durationMs: 70_000 },
    });
    const result = scoreVideo(prior, current);
    assert.strictEqual(result.state, 'REPLACED', `Got ${result.state}, score=${result.score}`);
});

// 5. ffprobe null on prior → UNKNOWN
test('ffprobe null on prior → UNKNOWN', () => {
    const prior = makeFingerprint({ ffprobe: null });
    const current = makeFingerprint();
    const result = scoreVideo(prior, current);
    assert.strictEqual(result.state, 'UNKNOWN', `Got ${result.state}`);
});

// 6. Chunk hashes differ but duration & playback match → MINOR_CHANGE
test('chunk hashes differ, duration & playback match → MINOR_CHANGE', () => {
    const prior = makeFingerprint();
    const current = makeFingerprint({
        chunks: { first: 'xxxx', middle: 'yyyy', last: 'zzzz', fileSize: 10_000_000 },
    });
    const result = scoreVideo(prior, current);
    // playback match (2) + duration match (4) + codec match (1) = 7, chunks all mismatch (0)
    // score 7 < 8, so MINOR_CHANGE
    assert.strictEqual(result.state, 'MINOR_CHANGE', `Got ${result.state}, score=${result.score}`);
});

// scoreBody tests
test('scoreBody identical hashes → UNCHANGED', () => {
    assert.strictEqual(scoreBody('abc', 'abc'), 'UNCHANGED');
});

test('scoreBody different hashes → MINOR', () => {
    assert.strictEqual(scoreBody('abc', 'def'), 'MINOR');
});

test('scoreBody null → MINOR', () => {
    assert.strictEqual(scoreBody(null, 'abc'), 'MINOR');
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
