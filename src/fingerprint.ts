import crypto from 'crypto';
import type { Lesson, Resource } from './scraper.js';
import type { FullFingerprint } from './fingerprint/types.js';
import { probeVideo } from './fingerprint/ffprobe.js';
import { chunkHashes } from './fingerprint/chunks.js';
import { bodyHash } from './fingerprint/body.js';

export type { FullFingerprint } from './fingerprint/types.js';

export type VideoSource = 'youtube' | 'loom' | 'mux' | 'other';

export type VideoFingerprint = {
    source: VideoSource;
    ytDlpId?: string;
    durationSec?: number;
    playbackId?: string;
};

export function classifyVideoSource(url: string | undefined): VideoSource {
    if (!url) return 'other';
    if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
    if (/loom\.com/.test(url)) return 'loom';
    if (/stream\.video\.skool\.com|mux\.com/.test(url)) return 'mux';
    return 'other';
}

export function extractMuxPlaybackId(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        if (!/skool\.com|mux\.com/.test(parsed.hostname)) return undefined;
        const match = parsed.pathname.match(/\/([^\/]+?)\.m3u8$/);
        return match ? match[1] : undefined;
    } catch {
        return undefined;
    }
}

type ResourceFingerprint = {
    title: string;
    file_id?: string;
    external?: string;
};

function canonicalResources(resources: Resource[] | undefined): ResourceFingerprint[] {
    if (!resources) return [];
    return resources
        .map(r => ({
            title: r.title ?? '',
            file_id: r.file_id,
            external: r.isExternal ? r.downloadUrl : undefined
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

export function computeContentHash(lesson: Pick<Lesson, 'title' | 'contentHtml' | 'resources'>): string {
    const payload = JSON.stringify({
        title: lesson.title ?? '',
        contentHtml: lesson.contentHtml ?? '',
        resources: canonicalResources(lesson.resources)
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

export function videoFingerprintsEqual(a?: VideoFingerprint, b?: VideoFingerprint): boolean {
    if (!a || !b) return false;
    if (a.source !== b.source) return false;

    if (a.source === 'mux' && a.playbackId && b.playbackId) {
        return a.playbackId === b.playbackId;
    }

    if (!a.ytDlpId || !b.ytDlpId) return false;
    if (a.ytDlpId !== b.ytDlpId) return false;

    if (a.durationSec !== undefined && b.durationSec !== undefined) {
        if (Math.abs(a.durationSec - b.durationSec) > 1) return false;
    }

    return true;
}

/**
 * LessonManifest extension — carries the optional full fingerprint alongside the
 * existing lightweight VideoFingerprint. Phase 1's two-pass classifier will write
 * this field; Phase 2's scoring engine reads it.
 */
export type LessonManifestFullFingerprintExtension = {
    fp_schema?: 2;
    fullFingerprint?: FullFingerprint;
};

/**
 * Compute a full Phase-2 fingerprint for a lesson.
 *
 * Phase 1 integration seam — call this after the local video file is confirmed
 * present on disk, before the equality check:
 *
 *   const full = await computeFullFingerprint(videoPath, lessonData.contentHtml ?? '', playbackId);
 *
 * Then pass `oldManifest.fullFingerprint` and `full` into `scoreVideo()` from
 * `src/fingerprint/score.ts` to obtain a `VideoVerdict`.
 *
 * @param videoPath       Absolute path to the local .mp4 / .webm file.
 * @param bodyHtml        Raw HTML string of lesson.contentHtml (may be empty).
 * @param existingPlaybackId  Mux playback ID already extracted from the video URL,
 *                            if available (passed through unchanged).
 */
export async function computeFullFingerprint(
    videoPath: string,
    // Pass the raw HTML string, or null if index.html is not available on disk.
    // When null, bodyHash is stored as null so scoreBody treats it as UNKNOWN
    // rather than producing a false MINOR mismatch against a real hash.
    bodyHtml: string | null,
    existingPlaybackId?: string,
): Promise<FullFingerprint> {
    const [ffprobeResult, chunksResult] = await Promise.all([
        probeVideo(videoPath),
        chunkHashes(videoPath).catch(() => null),
    ]);

    return {
        fp_schema: 2,
        playbackId: existingPlaybackId,
        ffprobe: ffprobeResult,
        chunks: chunksResult,
        bodyHash: bodyHtml !== null ? bodyHash(bodyHtml) : null,
    };
}
