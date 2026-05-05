/**
 * Integration test for P0-6: verify that .group-log.json is written (mtime advances
 * and fp_schema=2 is stamped) when downloadCourse runs with update:true and all
 * lessons are UNCHANGED.
 *
 * Uses a tmp dir with 5 synthetic lesson dirs (lesson.json + index.html + fake video).
 * Mocks Scraper and Downloader so no network or Playwright is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mock scraper and downloader BEFORE importing downloadCourse
// ---------------------------------------------------------------------------

// Build a fake 1-byte video so ffprobe can be mocked away too.
// We also mock computeFullFingerprint to avoid real ffprobe/fpcalc calls.

vi.mock('../scraper.js', () => {
    const lessons = Array.from({ length: 5 }, (_, i) => ({
        id: `lesson-id-${i}`,
        title: `Lesson ${i}`,
        url: `https://example.com/lesson-${i}`,
        index: i + 1,
        contentHtml: `<p>Lesson ${i} content</p>`,
        videoLink: `https://stream.video.skool.com/lesson-${i}.m3u8`,
        muxPlaybackId: `playback-${i}`,
        resources: [],
    }));

    const mockScraper = {
        parseClassroom: vi.fn().mockResolvedValue({
            groupName: 'TestGroup',
            courseName: 'TestCourse',
            courseImageUrl: undefined,
            modules: [
                {
                    title: 'Module 1',
                    index: 1,
                    lessons,
                    root: false,
                },
            ],
        }),
        extractLessonData: vi.fn().mockImplementation(async (url: string) => {
            const idx = lessons.findIndex(l => l.url === url);
            return lessons[idx];
        }),
        close: vi.fn().mockResolvedValue(undefined),
    };

    return {
        Scraper: vi.fn().mockImplementation(() => mockScraper),
    };
});

vi.mock('../downloader.js', () => {
    const mockDownloader = {
        localizeImages: vi.fn().mockImplementation(async (html: string) => html),
        getVideoFingerprint: vi.fn().mockResolvedValue({
            source: 'mux',
            playbackId: 'playback-0',
        }),
        downloadVideo: vi.fn().mockResolvedValue(undefined),
        downloadAsset: vi.fn().mockResolvedValue(undefined),
    };
    return {
        Downloader: vi.fn().mockImplementation(() => mockDownloader),
    };
});

// Mock computeFullFingerprint so ffprobe/chunks don't run against our 1-byte fake video.
vi.mock('../fingerprint.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../fingerprint.js')>();
    return {
        ...orig,
        computeFullFingerprint: vi.fn().mockResolvedValue({
            fp_schema: 2 as const,
            playbackId: 'playback-test',
            ffprobe: {
                durationMs: 60_000,
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
                fileSize: 1024,
            },
            bodyHash: crypto.createHash('sha256').update('<p>Lesson content</p>').digest('hex'),
        }),
    };
});

// Also mock regenerateIndex and regenerateGroupIndex to avoid file-system HTML generation.
vi.mock('../regenerate-index.js', () => ({
    regenerateIndex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../regenerate-group-index.js', () => ({
    regenerateGroupIndex: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Now import the system under test
// ---------------------------------------------------------------------------

import { downloadCourse } from '../index.js';
import type { GroupLog } from '../run-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupTmpVault(): Promise<{ groupDir: string; courseDir: string }> {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'skool-test-'));
    const groupDir = path.join(tmpBase, 'TestGroup');
    const courseDir = path.join(groupDir, 'TestCourse');
    const moduleDir = path.join(courseDir, 'Module-1');

    await fs.ensureDir(moduleDir);

    // Create 5 synthetic lesson dirs
    for (let i = 0; i < 5; i++) {
        const lessonDir = path.join(moduleDir, `${i + 1}-Lesson-${i}`);
        await fs.ensureDir(lessonDir);

        // lesson.json with prior fingerprint so the lesson is NOT treated as new
        const contentHash = crypto.createHash('sha256').update(
            JSON.stringify({ title: `Lesson ${i}`, contentHtml: `<p>Lesson ${i} content</p>`, resources: [] })
        ).digest('hex');

        const lessonManifest = {
            lessonId: `lesson-id-${i}`,
            title: `Lesson ${i}`,
            moduleIndex: 1,
            moduleTitle: 'Module 1',
            lessonIndex: i + 1,
            moduleDirName: 'Module-1',
            lessonDirName: `${i + 1}-Lesson-${i}`,
            relativePath: `Module-1/${i + 1}-Lesson-${i}/index.html`,
            hasVideo: true,
            resourcesCount: 0,
            updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
            contentHash,
            videoFingerprint: {
                source: 'mux',
                playbackId: `playback-${i}`,
            },
            fullFingerprint: {
                fp_schema: 2,
                playbackId: `playback-${i}`,
                ffprobe: {
                    durationMs: 60_000,
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
                    fileSize: 1024,
                },
                bodyHash: crypto.createHash('sha256').update('<p>Lesson content</p>').digest('hex'),
            },
            firstDownloadedAt: new Date(Date.now() - 86_400_000).toISOString(),
            lastCheckedAt: new Date(Date.now() - 86_400_000).toISOString(),
        };
        await fs.writeJson(path.join(lessonDir, 'lesson.json'), lessonManifest, { spaces: 2 });

        // index.html — required by P0-1 bodyHash fix
        await fs.writeFile(path.join(lessonDir, 'index.html'), `<p>Lesson ${i} content</p>`);

        // Fake 1 KB video so videoExistsBefore=true
        await fs.writeFile(path.join(lessonDir, 'video.mp4'), Buffer.alloc(1024));
    }

    return { groupDir, courseDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P0-6: .group-log.json written on --update even when all lessons UNCHANGED', () => {
    let tmpGroupDir: string;
    let tmpCourseDir: string;
    let groupLogPath: string;

    beforeEach(async () => {
        const dirs = await setupTmpVault();
        tmpGroupDir = dirs.groupDir;
        tmpCourseDir = dirs.courseDir;
        groupLogPath = path.join(tmpGroupDir, '.group-log.json');
    });

    afterEach(async () => {
        // Clean up tmp dir
        const base = path.dirname(tmpGroupDir);
        await fs.remove(base).catch(() => undefined);
    });

    it('creates .group-log.json when it does not exist yet', async () => {
        expect(fs.existsSync(groupLogPath)).toBe(false);

        await downloadCourse({
            url: 'https://www.skool.com/testgroup/classroom',
            outputDir: tmpCourseDir,
            update: true,
            suppressIndexLogs: true,
        });

        expect(fs.existsSync(groupLogPath)).toBe(true);

        const log = await fs.readJson(groupLogPath) as GroupLog;
        expect(log.fp_schema).toBe(2);
        expect(Array.isArray(log.runs)).toBe(true);
        expect(log.runs.length).toBeGreaterThanOrEqual(1);
        const lastRun = log.runs[log.runs.length - 1];
        expect(lastRun.mode).toBe('auto');
        expect(typeof lastRun.endedAt).toBe('string');
    });

    it('advances mtime and appends a new run entry when group-log already exists', async () => {
        // Write a pre-existing group-log with an old timestamp
        const oldLog: GroupLog = {
            schemaVersion: 1,
            fp_schema: 2,
            groupName: 'TestGroup',
            lessons: {},
            events: [],
            runs: [{
                runId: 'old-run-id',
                startedAt: new Date(Date.now() - 86_400_000).toISOString(),
                endedAt: new Date(Date.now() - 86_400_000).toISOString(),
                courseName: 'TestCourse',
                mode: 'auto',
                update: true,
                videosChecked: 5,
                videosNew: 0,
                videosUpdated: 0,
                textsChecked: 5,
                textsNew: 0,
                textsUpdated: 0,
                failed: 0,
            }],
        };
        await fs.writeJson(groupLogPath, oldLog, { spaces: 2 });
        const mtimeBefore = (await fs.stat(groupLogPath)).mtimeMs;

        // Small delay so mtime difference is detectable
        await new Promise(r => setTimeout(r, 50));

        await downloadCourse({
            url: 'https://www.skool.com/testgroup/classroom',
            outputDir: tmpCourseDir,
            update: true,
            suppressIndexLogs: true,
        });

        const mtimeAfter = (await fs.stat(groupLogPath)).mtimeMs;
        expect(mtimeAfter).toBeGreaterThan(mtimeBefore);

        const log = await fs.readJson(groupLogPath) as GroupLog;
        expect(log.fp_schema).toBe(2);
        expect(log.runs.length).toBe(2);
        const newRun = log.runs[1];
        expect(typeof newRun.endedAt).toBe('string');
        expect(new Date(newRun.endedAt).getTime()).toBeGreaterThan(
            new Date(oldLog.runs[0].endedAt).getTime()
        );
    });
});
