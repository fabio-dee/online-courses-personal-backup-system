/**
 * Regression test for offline-rebuild bodyHash behavior.
 *
 * Bug: index.html on disk is the rendered offline-viewer template (custom
 * wrapper, nav, theming, asset rewrites), NOT the raw lesson body. Hashing
 * it during stale-rebuild produced bodyHash that never matched the live
 * --update path's bodyHash (computed from raw lessonData.contentHtml),
 * causing 100% of text lessons to be flagged updated on every run.
 *
 * Invariant: offline rebuild paths (loadOrRebuildFingerprint, runRefingerprint)
 * must produce fingerprints with bodyHash === null. The legacy contentHash
 * field on lesson.json continues to catch real body changes.
 */

import { describe, it, expect } from 'vitest';
import { computeFullFingerprint } from '../fingerprint.js';
import { scoreBody } from '../fingerprint/score.js';

describe('offline rebuild bodyHash regression', () => {
    it('computeFullFingerprint with null bodyHtml returns bodyHash: null', async () => {
        // We can't run real ffprobe in CI, so pass a path that doesn't exist —
        // ffprobe returns null and computeFullFingerprint should still produce
        // a valid FullFingerprint with bodyHash: null. We don't care about the
        // ffprobe/chunks fields here, just the bodyHash invariant.
        const fp = await computeFullFingerprint('/nonexistent/video.mp4', null, undefined);
        expect(fp.bodyHash).toBeNull();
    });

    it('computeFullFingerprint with empty string bodyHtml returns a non-null hash', async () => {
        // Empty string IS valid input — caller chose to hash an empty body.
        // Only null means "no body data available, do not score".
        const fp = await computeFullFingerprint('/nonexistent/video.mp4', '', undefined);
        expect(fp.bodyHash).not.toBeNull();
        expect(typeof fp.bodyHash).toBe('string');
    });

    it('scoreBody returns UNCHANGED when prior bodyHash is null (refingerprint bootstrap case)', () => {
        // After --refingerprint, the sidecar has bodyHash: null. The next
        // --update will compare null prior vs real current. If scoreBody
        // returned MINOR here, every lesson would falsely flag text-updated.
        expect(scoreBody(null, 'sha256-of-real-body')).toBe('UNCHANGED');
    });

    it('scoreBody returns UNCHANGED when current bodyHash is null', () => {
        expect(scoreBody('sha256-of-real-body', null)).toBe('UNCHANGED');
    });

    it('scoreBody returns UNCHANGED when both null', () => {
        expect(scoreBody(null, null)).toBe('UNCHANGED');
    });

    it('scoreBody returns MINOR when both hashes are real and different', () => {
        // Sanity check: real body change still detected.
        expect(scoreBody('hash-A', 'hash-B')).toBe('MINOR');
    });

    it('scoreBody returns UNCHANGED when both hashes match', () => {
        expect(scoreBody('hash-A', 'hash-A')).toBe('UNCHANGED');
    });
});

describe('source code invariant: offline paths pass null bodyHtml', () => {
    /**
     * Static check: read src/index.ts and confirm that the two offline
     * computeFullFingerprint call sites (loadOrRebuildFingerprint and
     * runRefingerprint) pass `null` as the bodyHtml argument, NOT a
     * value derived from index.html.
     *
     * This catches the regression at code-review time even before tests run.
     */
    it('loadOrRebuildFingerprint and runRefingerprint pass null bodyHtml', async () => {
        const fs = await import('fs/promises');
        const path = await import('path');
        const url = await import('url');
        const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
        const indexPath = path.resolve(__dirname, '..', 'index.ts');
        const src = await fs.readFile(indexPath, 'utf8');

        // Locate the two functions and check the computeFullFingerprint call inside them
        const loadFnStart = src.indexOf('async function loadOrRebuildFingerprint');
        expect(loadFnStart).toBeGreaterThan(-1);
        const loadFnEnd = src.indexOf('\n}\n', loadFnStart);
        const loadFnBody = src.slice(loadFnStart, loadFnEnd);
        // Must have a computeFullFingerprint call with null as second arg
        expect(loadFnBody).toMatch(/computeFullFingerprint\([^)]*\bnull\b/);
        // Must NOT read index.html for body content
        expect(loadFnBody).not.toMatch(/readFile\([^)]*index\.html/);

        const refpFnStart = src.indexOf('async function runRefingerprint');
        expect(refpFnStart).toBeGreaterThan(-1);
        const refpFnEnd = src.indexOf('\n}\n', refpFnStart);
        const refpFnBody = src.slice(refpFnStart, refpFnEnd);
        expect(refpFnBody).toMatch(/computeFullFingerprint\([^)]*\bnull\b/);
        expect(refpFnBody).not.toMatch(/readFile\([^)]*index\.html/);
    });
});
