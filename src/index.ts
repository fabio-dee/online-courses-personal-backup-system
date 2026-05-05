import { Scraper, Module } from './scraper.js';
import { Downloader } from './downloader.js';
import { regenerateIndex } from './regenerate-index.js';
import { regenerateGroupIndex } from './regenerate-group-index.js';
import { createConsoleLogger, type Logger } from './logger.js';
import {
    computeContentHash,
    videoFingerprintsEqual,
    computeFullFingerprint,
    type VideoFingerprint,
    type FullFingerprint,
} from './fingerprint.js';
import { scoreVideo, scoreBody } from './fingerprint/score.js';
import { escalatedScore } from './fingerprint/perceptual/escalate.js';
import type { PerceptualFingerprint } from './fingerprint/perceptual/types.js';
import {
    createRunStats,
    mergeRunIntoLog,
    stampFpSchema,
    printRunReport,
    type LessonChange,
    type LessonEventType,
    type LessonOutcome
} from './run-log.js';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

/**
 * Thrown by the sanity-check when >30% of lessons have no prior manifest.
 * Caught by the CLI entry point AFTER scraper.close() runs via the finally block,
 * so Playwright is never leaked (P0-4 fix — replaces process.exit(2) inside try).
 */
export class SanityCheckAbort extends Error {
    readonly exitCode = 2;
    constructor(message: string) {
        super(message);
        this.name = 'SanityCheckAbort';
    }
}

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;

const indexLimit = pLimit(1);
const groupIndexLimit = pLimit(1);
let activeOutputDir: string | null = null;
let activeGroupDir: string | null = null;
let shutdownHandlersRegistered = false;

function registerShutdownHandlers(logger: Logger) {
    if (shutdownHandlersRegistered) return;
    shutdownHandlersRegistered = true;

    const handleShutdown = async (signal: string) => {
        if (!activeOutputDir) {
            process.exit(0);
            return;
        }
        logger.warn(`\n🛑 Caught ${signal}. Regenerating index before exit...`);
        try {
            await regenerateIndex(activeOutputDir);
            if (activeGroupDir) {
                await regenerateGroupIndex(activeGroupDir);
            }
        } catch (err) {
            logger.error('⚠️ Failed to regenerate index during shutdown.', err);
        } finally {
            process.exit(0);
        }
    };

    process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
    process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
}

type CourseManifest = {
    courseName: string;
    groupName: string;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
        root?: boolean;
    }>;
    updatedAt: string;
};

type LessonManifest = {
    lessonId: string;
    title: string;
    moduleIndex: number;
    moduleTitle: string;
    lessonIndex: number;
    moduleDirName: string;
    lessonDirName: string;
    relativePath: string;
    hasVideo: boolean;
    resourcesCount: number;
    updatedAt: string;
    contentHash?: string;
    videoFingerprint?: VideoFingerprint;
    /** Phase 2+ full fingerprint. Present when fp_schema=2. */
    fullFingerprint?: FullFingerprint;
    firstDownloadedAt?: string;
    lastCheckedAt?: string;
    lastTextChangedAt?: string;
    lastVideoChangedAt?: string;
};

export type DownloadMode = 'auto' | 'course' | 'lesson';

export type DownloadCallbacks = {
    onCourseStart?: (info: {
        courseName: string;
        groupName: string;
        modulesCount: number;
        lessonsCount: number;
        outputDir: string;
        targetLessonId: string | null;
        lessonDestination?: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null;
    }) => void;
    onLessonStart?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
    }) => void;
    onLessonComplete?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        hasVideo: boolean;
        resourcesCount: number;
    }) => void;
    onLessonError?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        error: unknown;
    }) => void;
    onCourseComplete?: (summary: DownloadSummary) => void;
};

export type DownloadOptions = {
    url: string;
    outputDir?: string;
    concurrency?: number;
    mode?: DownloadMode;
    lessonId?: string | null;
    logger?: Logger;
    callbacks?: DownloadCallbacks;
    suppressIndexLogs?: boolean;
    runTasks?: (tasks: LessonTask[], concurrency: number) => Promise<void>;
    update?: boolean;
    /** Skip the sanity-check abort even when >30% of prior lessons are flagged new. */
    forceUpdate?: boolean;
    /**
     * When true: rebuild every lesson's FullFingerprint from local disk (no network),
     * write updated lesson.json + lesson.fingerprint.json sidecars, then exit.
     * No scraping, no downloading.
     */
    refingerprint?: boolean;
};

export type DownloadSummary = {
    courseName: string;
    groupName: string;
    outputDir: string;
    modulesCount: number;
    lessonsCount: number;
    completedLessons: number;
    failedLessons: number;
    targetLessonId: string | null;
};

export type LessonTask = {
    title: string;
    run: (onStatus?: (message: string) => void) => Promise<void>;
};

async function writeAtomicJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
}

/** Write (or overwrite) the per-lesson sidecar fingerprint file. */
async function writeFingerprintSidecar(lessonDir: string, fp: FullFingerprint): Promise<void> {
    await writeAtomicJson(path.join(lessonDir, 'lesson.fingerprint.json'), fp);
}

/**
 * Read the sidecar fingerprint for a lesson dir, preferring sidecar over in-manifest copy.
 * Returns null if neither exists or sidecar is unparseable.
 */
async function readFingerprintSidecar(lessonDir: string): Promise<FullFingerprint | null> {
    const sidecarPath = path.join(lessonDir, 'lesson.fingerprint.json');
    if (!fs.existsSync(sidecarPath)) return null;
    try {
        const data = await fs.readJson(sidecarPath) as unknown;
        if (
            typeof data === 'object' && data !== null &&
            (data as { fp_schema?: unknown }).fp_schema === 2
        ) {
            return data as FullFingerprint;
        }
    } catch {
        // Ignore corrupt sidecar; fall through to null
    }
    return null;
}

/**
 * Load or lazily rebuild a FullFingerprint for an existing lesson.
 * Returns { fp, wasStale } — wasStale=true means it was rebuilt from disk.
 * NEVER treats a stale lesson as new; always returns an fp if video exists.
 */
async function loadOrRebuildFingerprint(
    lessonDir: string,
    manifest: LessonManifest,
): Promise<{ fp: FullFingerprint | null; wasStale: boolean }> {
    // Prefer sidecar over in-manifest copy
    const sidecar = await readFingerprintSidecar(lessonDir);
    if (sidecar !== null) {
        return { fp: sidecar, wasStale: false };
    }
    if (manifest.fullFingerprint?.fp_schema === 2) {
        return { fp: manifest.fullFingerprint, wasStale: false };
    }

    // Stale: rebuild from disk (no network)
    const videoPath = path.join(lessonDir, 'video.mp4');
    const hevcPath = path.join(lessonDir, 'video.hevc.mp4');
    const existingVideoPath = [videoPath, hevcPath].find(
        p => fs.existsSync(p) && fs.statSync(p).size > 0
    );
    if (!existingVideoPath) {
        return { fp: null, wasStale: true };
    }

    // Read the saved HTML from disk so bodyHash is computed from actual content,
    // not from manifest.contentHash which is already a sha256 hex string (wrong input).
    // If index.html is absent, pass null and bodyHash will be null in the fp.
    const indexHtmlPath = path.join(lessonDir, 'index.html');
    const bodyHtml: string | null = fs.existsSync(indexHtmlPath)
        ? await fs.readFile(indexHtmlPath, 'utf8').catch(() => null)
        : null;

    try {
        const fp = await computeFullFingerprint(
            existingVideoPath,
            bodyHtml,
            manifest.videoFingerprint?.playbackId,
        );
        return { fp, wasStale: true };
    } catch {
        return { fp: null, wasStale: true };
    }
}

/**
 * Run the --refingerprint pass: scan all existing lesson.json files under outputDir,
 * rebuild FullFingerprint from disk for each, write updated lesson.json + sidecar.
 * No scraping, no downloading.
 */
async function runRefingerprint(outputDir: string, logger: Logger): Promise<void> {
    logger.info('🔬 --refingerprint: scanning vault for lessons to re-fingerprint...');
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    let rebuilt = 0;
    let skipped = 0;

    // Collect every group dir that contains a touched course so we can stamp
    // fp_schema=2 on .group-log.json after the walk (P0-5 fix).
    // A "group dir" is the parent of outputDir (i.e. outputDir itself when the
    // user passes the group root, or path.dirname(outputDir) otherwise).
    // We stamp the parent of each course dir that contained at least one lesson.
    const touchedGroupDirs = new Set<string>();

    // Walk at most 2 levels deep (module/lesson or root/lesson)
    async function processDir(dir: string) {
        let items: fs.Dirent[];
        try {
            items = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const item of items) {
            if (!item.isDirectory()) continue;
            const subDir = path.join(dir, item.name);
            const manifestPath = path.join(subDir, 'lesson.json');
            if (fs.existsSync(manifestPath)) {
                // This is a lesson dir
                try {
                    const manifest = await fs.readJson(manifestPath) as LessonManifest;
                    if (!manifest.lessonId) continue;

                    const videoPath = path.join(subDir, 'video.mp4');
                    const hevcPath = path.join(subDir, 'video.hevc.mp4');
                    const existingVideoPath = [videoPath, hevcPath].find(
                        p => fs.existsSync(p) && fs.statSync(p).size > 0
                    );
                    if (!existingVideoPath) {
                        skipped += 1;
                        continue;
                    }

                    // Read saved HTML from disk so bodyHash is computed from actual content.
                    // If index.html is absent, pass null — bodyHash will be null in the fp.
                    const indexHtmlPath = path.join(subDir, 'index.html');
                    const bodyHtml: string | null = fs.existsSync(indexHtmlPath)
                        ? await fs.readFile(indexHtmlPath, 'utf8').catch(() => null)
                        : null;
                    const fp = await computeFullFingerprint(
                        existingVideoPath,
                        bodyHtml,
                        manifest.videoFingerprint?.playbackId,
                    );
                    const updatedManifest: LessonManifest = { ...manifest, fullFingerprint: fp };
                    await writeAtomicJson(manifestPath, updatedManifest);
                    await writeFingerprintSidecar(subDir, fp);
                    rebuilt += 1;
                    // Track the group dir (parent of the course dir) so we can
                    // stamp fp_schema=2 on .group-log.json after the walk.
                    touchedGroupDirs.add(path.dirname(path.dirname(subDir)));
                    logger.info(`  ✅ Re-fingerprinted: ${manifest.title}`);
                } catch (err) {
                    logger.warn(`  ⚠️ Failed to re-fingerprint ${subDir}: ${String(err)}`);
                    skipped += 1;
                }
            } else {
                // Might be a module dir — recurse one level
                await processDir(subDir);
            }
        }
    }

    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
            await processDir(path.join(outputDir, entry.name));
        }
    }

    // Stamp fp_schema=2 on every touched group's .group-log.json (P0-5 fix).
    // --refingerprint previously early-returned before mergeRunIntoLog, so the
    // group log never got the fp_schema stamp that --update relies on.
    for (const groupDir of touchedGroupDirs) {
        try {
            await stampFpSchema(groupDir);
            logger.info(`  📝 Stamped fp_schema=2 on ${groupDir}/.group-log.json`);
        } catch (err) {
            logger.warn(`  ⚠️ Failed to stamp group log at ${groupDir}: ${String(err)}`);
        }
    }

    logger.info(`🔬 --refingerprint complete: ${rebuilt} rebuilt, ${skipped} skipped (no video).`);
}

function getUrlExtension(url: string) {
    try {
        const ext = path.extname(new URL(url).pathname);
        if (ext && ext.length <= 5) return ext;
    } catch (err) {
        // Ignore parsing errors, fallback below.
    }
    return '.jpg';
}

function sanitizeName(value: string) {
    return value.replace(/[/\\?%*:|"<>]/g, '-');
}

function resolveTargetLessonId(
    url: string,
    mode: DownloadMode,
    explicitLessonId?: string | null
) {
    if (mode === 'course') return null;

    let targetLessonId = explicitLessonId ?? null;
    try {
        const urlObj = new URL(url);
        if (!targetLessonId) {
            targetLessonId = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');
        }
    } catch (err) {
        // Ignore parsing errors, caller will validate.
    }

    if (mode === 'lesson' && !targetLessonId) {
        throw new Error('Lesson mode requires a lesson id in the URL or explicit lessonId option.');
    }

    return targetLessonId;
}

function normalizeConcurrency(value: number | undefined) {
    if (!Number.isFinite(value) || value === undefined) return DEFAULT_CONCURRENCY;
    const floored = Math.floor(value);
    if (floored <= 0) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, floored);
}

async function runConcurrent(tasks: Array<() => Promise<void>>, concurrency: number) {
    if (tasks.length === 0) return;
    if (concurrency <= 1 || tasks.length === 1) {
        for (const task of tasks) {
            await task();
        }
        return;
    }

    let index = 0;
    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= tasks.length) return;
            await tasks[current]();
        }
    });

    await Promise.all(workers);
}

export async function downloadCourse(options: DownloadOptions): Promise<DownloadSummary> {
    const logger = options.logger ?? createConsoleLogger();

    // --refingerprint: rebuild all fingerprints from disk, no network needed.
    if (options.refingerprint) {
        const outputDir = options.outputDir && options.outputDir !== 'undefined'
            ? options.outputDir
            : path.join(process.cwd(), 'downloads');
        await runRefingerprint(outputDir, logger);
        // Return a minimal summary — caller doesn't use it in this mode.
        return {
            courseName: '',
            groupName: '',
            outputDir,
            modulesCount: 0,
            lessonsCount: 0,
            completedLessons: 0,
            failedLessons: 0,
            targetLessonId: null,
        };
    }

    const concurrency = normalizeConcurrency(options.concurrency);
    const mode = options.mode ?? 'auto';
    const inputUrl = options.url.replace(/\\/g, '');

    let classroomUrl = inputUrl;
    try {
        classroomUrl = new URL(inputUrl).toString();
    } catch (err) {
        throw new Error(`Invalid URL: ${inputUrl}`);
    }

    const targetLessonId = resolveTargetLessonId(classroomUrl, mode, options.lessonId);
    classroomUrl = classroomUrl.split('?')[0];

    const scraper = new Scraper(logger);
    const downloader = new Downloader(logger);

    let completedLessons = 0;
    let failedLessons = 0;

    const stats = createRunStats({
        courseName: '',
        groupName: '',
        mode,
        update: options.update === true
    });

    try {
        logger.info('🚀 Fetching course structure...');
        let { modules, courseName, groupName, courseImageUrl } = await scraper.parseClassroom(classroomUrl);
        stats.courseName = courseName;
        stats.groupName = groupName;

        if (modules.length === 0) {
            throw new Error('No modules found. Are you sure this is a classroom URL and you are logged in?');
        }

        if (targetLessonId) {
            logger.info(`📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
            let found = false;
            for (const module of modules) {
                const lesson = module.lessons.find(l => l.id === targetLessonId);
                if (lesson) {
                    module.lessons = [lesson];
                    modules = [module];
                    found = true;
                    break;
                }
            }

            if (!found) {
                throw new Error(`Could not find lesson with ID ${targetLessonId} in this classroom.`);
            }

            logger.info(`✅ Found lesson: ${modules[0].lessons[0].title}`);
        } else {
            logger.info(`✅ Found ${modules.length} modules.`);
        }

        const sanitizedGroupName = sanitizeName(groupName);
        const sanitizedCourseName = sanitizeName(courseName);

        const defaultOutputDir = path.join(
            process.cwd(),
            'downloads',
            sanitizedGroupName,
            sanitizedCourseName
        );

        const outputOverride =
            options.outputDir && options.outputDir !== 'undefined'
                ? options.outputDir
                : undefined;
        const baseOutputDir = outputOverride || defaultOutputDir;
        if (!baseOutputDir) {
            throw new Error('Output directory resolution failed.');
        }

        await fs.ensureDir(baseOutputDir);
        activeOutputDir = baseOutputDir;
        activeGroupDir = path.dirname(baseOutputDir);
        registerShutdownHandlers(logger);

        const courseInfo: Array<{
            title: string;
            lessons: any[];
            totalLessons: number;
            mIndex: number;
            moduleDirName: string;
        }> = modules.map(m => ({
            title: m.title,
            lessons: [] as any[],
            totalLessons: m.lessons.length,
            mIndex: m.index,
            moduleDirName: m.root ? '' : `${m.index}-${sanitizeName(m.title)}`
        }));

        let lessonDestination: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null = null;

        if (targetLessonId && modules[0]?.lessons?.length) {
            const module = modules[0];
            const lesson = module.lessons[0];
            const moduleInfo = courseInfo[0];
            const lessonIndex = lesson.index ?? 1;
            const lessonDirName = `${lessonIndex}-${sanitizeName(lesson.title)}`;
            const lessonOutputDir = path.join(baseOutputDir, moduleInfo.moduleDirName, lessonDirName);
            lessonDestination = {
                moduleIndex: moduleInfo.mIndex,
                moduleTitle: moduleInfo.title,
                moduleDirName: moduleInfo.moduleDirName,
                lessonIndex,
                lessonTitle: lesson.title,
            lessonDirName,
            lessonOutputDir,
            lessonRelativePath: moduleInfo.moduleDirName
                ? `${moduleInfo.moduleDirName}/${lessonDirName}/index.html`
                : `${lessonDirName}/index.html`
        };
    }

        const totalLessons = modules.reduce((sum, module) => sum + module.lessons.length, 0);
        options.callbacks?.onCourseStart?.({
            courseName,
            groupName,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            outputDir: baseOutputDir,
            targetLessonId,
            lessonDestination
        });

        let courseImagePath: string | undefined;
        if (courseImageUrl) {
            try {
                const assetsDir = path.join(baseOutputDir, 'assets');
                await fs.ensureDir(assetsDir);
                const ext = getUrlExtension(courseImageUrl);
                const localName = `course-cover${ext}`;
                const localPath = path.join(assetsDir, localName);
                await downloader.downloadAsset(courseImageUrl, localPath);
                courseImagePath = `assets/${localName}`;
            } catch (err) {
                logger.warn('⚠️ Failed to download course image, continuing without it.');
            }
        }

        const courseManifest: CourseManifest = {
            courseName,
            groupName,
            courseImageUrl,
            courseImagePath,
            modules: courseInfo.map(m => ({
                index: m.mIndex,
                title: m.title,
                moduleDirName: m.moduleDirName,
                root: modules.find(mod => mod.index === m.mIndex)?.root
            })),
            updatedAt: new Date().toISOString()
        };

        await writeAtomicJson(path.join(baseOutputDir, '.course.json'), courseManifest);

        // ---------------------------------------------------------------------------
        // Pass 0: Build per-module lessonId→dirName maps (filesystem scan, no network).
        // This allows us to find existing lesson dirs even when Skool reorders lessons.
        // ---------------------------------------------------------------------------
        /** Returns a map of lessonId → existing subdirectory name within moduleDir. */
        async function buildLessonIdMap(moduleDir: string): Promise<Map<string, string>> {
            const map = new Map<string, string>();
            let entries: string[];
            try {
                entries = await fs.readdir(moduleDir);
            } catch {
                return map;
            }
            await Promise.all(entries.map(async (entry) => {
                const manifestPath = path.join(moduleDir, entry, 'lesson.json');
                try {
                    if (!fs.existsSync(manifestPath)) return;
                    const manifest = await fs.readJson(manifestPath) as { lessonId?: string };
                    if (manifest.lessonId) {
                        map.set(manifest.lessonId, entry);
                    }
                } catch {
                    // Ignore unreadable manifests
                }
            }));
            return map;
        }

        // ---------------------------------------------------------------------------
        // Pass 1: Classify every lesson (new vs existing) purely from the filesystem.
        // Used for the sanity-check abort before any network downloads happen.
        // ---------------------------------------------------------------------------
        type LessonClassification = {
            lessonId: string;
            title: string;
            moduleTitle: string;
            resolvedDirName: string;
            isNew: boolean; // true when no prior lesson.json found
        };

        const allClassifications: LessonClassification[] = [];

        // Per-module lessonId→dirName caches (reused in pass 2 task closures).
        const moduleLessonIdMaps = new Map<number, Map<string, string>>();

        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = mInfo.moduleDirName ? path.join(baseOutputDir, mInfo.moduleDirName) : baseOutputDir;

            const idMap = await buildLessonIdMap(moduleDir);
            moduleLessonIdMaps.set(i, idMap);

            for (const lesson of module.lessons) {
                const lIndex = lesson.index ?? 1;
                const constructedDirName = `${lIndex}-${sanitizeName(lesson.title)}`;
                // Prefer the dir found by lessonId; fall back to constructed name.
                const resolvedDirName = idMap.get(lesson.id) ?? constructedDirName;
                const manifestPath = path.join(moduleDir, resolvedDirName, 'lesson.json');
                const isNew = !fs.existsSync(manifestPath);
                allClassifications.push({
                    lessonId: lesson.id,
                    title: lesson.title,
                    moduleTitle: mInfo.title,
                    resolvedDirName,
                    isNew
                });
            }
        }

        // ---------------------------------------------------------------------------
        // Sanity-check abort (update mode only, skipped with --force-update).
        // ---------------------------------------------------------------------------
        if (options.update && !options.forceUpdate) {
            // Count lessons that had a prior manifest anywhere in baseOutputDir.
            // "Prior" = existed before this run started, regardless of module.
            const totalPrior = allClassifications.filter(c => !c.isNew).length;
            const videosNew = allClassifications.filter(c => c.isNew).length;
            const ratio = videosNew / Math.max(totalPrior, 1);

            if (totalPrior >= 20 && ratio > 0.30) {
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const abortFile = path.join(baseOutputDir, `.update-aborted-${ts}.json`);

                const flagged = allClassifications
                    .filter(c => c.isNew)
                    .map(c => ({ lessonId: c.lessonId, title: c.title, moduleTitle: c.moduleTitle, reason: 'no-prior-manifest' }));

                const report = {
                    abortedAt: new Date().toISOString(),
                    courseName,
                    baseOutputDir,
                    totalPrior,
                    videosNew,
                    ratio: Math.round(ratio * 1000) / 1000,
                    flagged
                };

                try {
                    await writeAtomicJson(abortFile, report);
                } catch {
                    // Best-effort; don't mask the real error.
                }

                // Print table to stderr.
                process.stderr.write(`\n⛔  Sanity-check abort — ${videosNew} of ${totalPrior + videosNew} lessons have no prior manifest (${Math.round(ratio * 100)}% > 30%).\n`);
                process.stderr.write(`    This usually means lesson directories were renamed due to upstream reordering.\n`);
                process.stderr.write(`    Re-run with --force-update to bypass, or check the report: ${abortFile}\n\n`);
                process.stderr.write(`    Flagged lessons (first 20):\n`);
                process.stderr.write(`    ${'lessonId'.padEnd(36)} ${'module'.padEnd(30)} title\n`);
                process.stderr.write(`    ${'-'.repeat(36)} ${'-'.repeat(30)} ${'-'.repeat(40)}\n`);
                for (const f of flagged.slice(0, 20)) {
                    process.stderr.write(`    ${f.lessonId.padEnd(36)} ${f.moduleTitle.slice(0, 30).padEnd(30)} ${f.title.slice(0, 60)}\n`);
                }
                if (flagged.length > 20) {
                    process.stderr.write(`    ... and ${flagged.length - 20} more (see ${abortFile})\n`);
                }
                process.stderr.write('\n');

                // Throw instead of process.exit(2) so the finally block runs
                // scraper.close() before Node exits (P0-4: prevents Playwright leak).
                throw new SanityCheckAbort(
                    `Sanity-check abort — ${videosNew} of ${totalPrior + videosNew} lessons have no prior manifest`
                );
            }
        }

        // ---------------------------------------------------------------------------
        // Pass 2: Build download task list, reusing the lessonId maps from pass 0.
        // ---------------------------------------------------------------------------
        const tasks: LessonTask[] = [];

        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = mInfo.moduleDirName ? path.join(baseOutputDir, mInfo.moduleDirName) : baseOutputDir;
            if (mInfo.moduleDirName) {
                await fs.ensureDir(moduleDir);
            }

            const idMap = moduleLessonIdMaps.get(i) ?? new Map<string, string>();

            for (const lesson of module.lessons) {
                const lIndex = lesson.index ?? 1;
                const taskTitle = `[${mInfo.mIndex}.${lIndex}] ${lesson.title}`;
                tasks.push({
                    title: taskTitle,
                    run: async (onStatus) => {
                        const updateStatus = (message?: string) => {
                            if (!onStatus || !message) return;
                            onStatus(message);
                        };
                        const constructedDirName = `${lIndex}-${sanitizeName(lesson.title)}`;
                        // Prefer existing dir found by lessonId; fall back to constructed name.
                        const lessonDirName = idMap.get(lesson.id) ?? constructedDirName;
                        const lessonDir = path.join(moduleDir, lessonDirName);

                        options.callbacks?.onLessonStart?.({
                            moduleIndex: mInfo.mIndex,
                            lessonIndex: lIndex,
                            lessonTitle: lesson.title
                        });

                        logger.info(`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`);

                        try {
                            updateStatus('Loading lesson data...');
                            await fs.ensureDir(lessonDir);
                            const lessonData = await scraper.extractLessonData(lesson.url);

                            const manifestPath = path.join(lessonDir, 'lesson.json');
                            let oldManifest: LessonManifest | null = null;
                            if (fs.existsSync(manifestPath)) {
                                try { oldManifest = await fs.readJson(manifestPath) as LessonManifest; }
                                catch { oldManifest = null; }
                            }

                            const newContentHash = computeContentHash(lessonData);
                            const isNewLesson = oldManifest == null;
                            const textChanged = !isNewLesson && oldManifest?.contentHash !== newContentHash;

                            stats.textsChecked += 1;
                            if (lessonData.videoLink) {
                                stats.videosChecked += 1;
                            }

                            updateStatus('Localizing images...');
                            const localizedHtml = await downloader.localizeImages(lessonData.contentHtml || '', lessonDir);

                            let hasVideo = false;
                            let videoChanged = false;
                            let videoWasNewlyDownloaded = false;
                            let videoFingerprint: VideoFingerprint | undefined = oldManifest?.videoFingerprint;
                            // Tracks the freshest FullFingerprint computed during this lesson run.
                            // Hoisted here so the manifest-write below can always use the latest value
                            // rather than the stale oldManifest.fullFingerprint (P0-2 fix).
                            let lastComputedFullFp: FullFingerprint | null = null;
                            if (lessonData.videoLink) {
                                const videoPath = path.join(lessonDir, 'video.mp4');
                                const hevcPath = path.join(lessonDir, 'video.hevc.mp4');
                                // Accept either the original download OR the post-encoded HEVC variant as "present".
                                const videoExistsBefore = [videoPath, hevcPath].some(
                                    (p) => fs.existsSync(p) && fs.statSync(p).size > 0,
                                );

                                if (options.update && videoExistsBefore) {
                                    updateStatus('Checking video freshness...');
                                    const newFp = await downloader.getVideoFingerprint(lessonData.videoLink);
                                    if (newFp && lessonData.muxPlaybackId && !newFp.playbackId) {
                                        newFp.playbackId = lessonData.muxPlaybackId;
                                    }

                                    const localVideoPath = [videoPath, hevcPath].find(
                                        p => fs.existsSync(p) && fs.statSync(p).size > 0
                                    ) ?? videoPath;

                                    const hasBaseline = oldManifest?.videoFingerprint != null;

                                    if (!hasBaseline) {
                                        // First --update run: record fingerprint, trust local file.
                                        logger.info(`    📝 Recording video fingerprint (first --update, trusting local file)`);
                                        hasVideo = true;
                                        videoFingerprint = newFp ?? undefined;
                                        // Compute and store full fingerprint for future runs.
                                        try {
                                            const fullFp = await computeFullFingerprint(
                                                localVideoPath,
                                                lessonData.contentHtml ?? '',
                                                newFp?.playbackId ?? lessonData.muxPlaybackId,
                                            );
                                            lastComputedFullFp = fullFp;
                                            videoFingerprint = newFp ?? undefined;
                                            const updatedManifest = oldManifest
                                                ? { ...oldManifest, fullFingerprint: fullFp }
                                                : null;
                                            if (updatedManifest) {
                                                await writeAtomicJson(path.join(lessonDir, 'lesson.json'), updatedManifest);
                                            }
                                            await writeFingerprintSidecar(lessonDir, fullFp);
                                        } catch {
                                            // Non-fatal: legacy path still works
                                        }
                                    } else {
                                        // Defense-in-depth: use full scoring engine when available.
                                        const { fp: priorFullFp, wasStale } = await loadOrRebuildFingerprint(lessonDir, oldManifest!);

                                        if (wasStale && priorFullFp) {
                                            // Write rebuilt fingerprint back to disk before comparing.
                                            await writeFingerprintSidecar(lessonDir, priorFullFp);
                                        }

                                        // Build current full fingerprint from the remote lightweight fp
                                        // plus local file signals.
                                        let currentFullFp: FullFingerprint | null = null;
                                        try {
                                            currentFullFp = await computeFullFingerprint(
                                                localVideoPath,
                                                lessonData.contentHtml ?? '',
                                                newFp?.playbackId ?? lessonData.muxPlaybackId,
                                            );
                                            // Track for manifest write (P0-2: persist freshly rebuilt fp)
                                            lastComputedFullFp = currentFullFp;
                                        } catch {
                                            // Fall back to legacy equality check below
                                        }

                                        let shouldRedownload = false;
                                        let videoStateLabel = 'UNKNOWN';

                                        if (priorFullFp && currentFullFp) {
                                            const verdict = scoreVideo(priorFullFp, currentFullFp);
                                            videoStateLabel = verdict.state;

                                            if (verdict.state === 'UNCHANGED') {
                                                shouldRedownload = false;
                                            } else if (verdict.state === 'REPLACED') {
                                                shouldRedownload = true;
                                            } else if (verdict.state === 'MINOR_CHANGE') {
                                                // Ambiguous: escalate to perceptual signals (Phase 3)
                                                // Cache hit: if prior perceptual data exists and L1–L3 agree,
                                                // reuse stored data and skip expensive ffmpeg/fpcalc.
                                                const priorPerceptual: PerceptualFingerprint | null =
                                                    priorFullFp.perceptual ?? null;
                                                const hasCachedPerceptual =
                                                    priorPerceptual !== null &&
                                                    priorPerceptual !== undefined;
                                                try {
                                                    const durationMs = currentFullFp.ffprobe?.durationMs ?? 0;
                                                    const escalation = await escalatedScore(
                                                        localVideoPath,
                                                        priorPerceptual,
                                                        durationMs,
                                                    );
                                                    // Store the freshly computed perceptual data (P0-3 fix:
                                                    // replaces empty stubs with real frames/audio).
                                                    currentFullFp.perceptual = escalation.computed;
                                                    lastComputedFullFp = currentFullFp;
                                                    if (escalation.perceptualScore >= 4) {
                                                        shouldRedownload = false;
                                                        videoStateLabel = hasCachedPerceptual
                                                            ? 'UNCHANGED(perceptual-cached)'
                                                            : 'UNCHANGED(perceptual)';
                                                    } else {
                                                        shouldRedownload = false; // MINOR_CHANGE: don't re-download unless REPLACED
                                                        videoStateLabel = 'MINOR_CHANGE';
                                                    }
                                                } catch {
                                                    shouldRedownload = false; // Conservative: don't re-download on escalation failure
                                                }
                                            } else {
                                                // UNKNOWN: treat as updated (re-download)
                                                shouldRedownload = true;
                                            }
                                        } else {
                                            // No full fingerprints available: fall back to legacy equality check
                                            if (newFp && !videoFingerprintsEqual(newFp, oldManifest!.videoFingerprint)) {
                                                shouldRedownload = true;
                                                videoStateLabel = 'REPLACED(legacy)';
                                            }
                                        }

                                        if (shouldRedownload) {
                                            logger.info(`    🔄 Video changed (${videoStateLabel}) — re-downloading`);
                                            const backupPath = `${videoPath}.bak`;
                                            if (fs.existsSync(videoPath)) {
                                                await fs.move(videoPath, backupPath, { overwrite: true });
                                            }
                                            try {
                                                updateStatus('Downloading video...');
                                                await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                                if (fs.existsSync(backupPath)) await fs.remove(backupPath);
                                                hasVideo = true;
                                                videoFingerprint = newFp ?? undefined;
                                                videoChanged = true;
                                                // Compute fresh full fingerprint after re-download
                                                try {
                                                    const freshFp = await computeFullFingerprint(
                                                        videoPath,
                                                        lessonData.contentHtml ?? '',
                                                        newFp?.playbackId ?? lessonData.muxPlaybackId,
                                                    );
                                                    await writeFingerprintSidecar(lessonDir, freshFp);
                                                    currentFullFp = freshFp;
                                                    lastComputedFullFp = freshFp;
                                                } catch {
                                                    // Non-fatal
                                                }
                                            } catch (err) {
                                                logger.warn(`    ⚠️ Video re-download failed; restoring previous file`);
                                                if (fs.existsSync(backupPath)) {
                                                    await fs.move(backupPath, videoPath, { overwrite: true });
                                                }
                                                hasVideo = true;
                                                videoFingerprint = oldManifest?.videoFingerprint;
                                            }
                                        } else {
                                            logger.info(`    ⏭️  Video unchanged (${videoStateLabel})`);
                                            hasVideo = true;
                                            videoFingerprint = newFp ?? oldManifest?.videoFingerprint;
                                            // Persist refreshed full fingerprint
                                            if (currentFullFp) {
                                                await writeFingerprintSidecar(lessonDir, currentFullFp);
                                            }
                                        }
                                    }
                                } else {
                                    try {
                                        updateStatus('Downloading video...');
                                        await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                        hasVideo = true;
                                        if (!videoExistsBefore) {
                                            videoWasNewlyDownloaded = true;
                                            const fp = await downloader.getVideoFingerprint(lessonData.videoLink);
                                            if (fp) videoFingerprint = fp;
                                        }
                                    } catch (err) {
                                        logger.warn(`    ⚠️ Failed to download video for ${lesson.title}`);
                                    }
                                }
                            }

                            const resourcesHtml: string[] = [];
                            if (lessonData.resources && lessonData.resources.length > 0) {
                                const resourcesDir = path.join(lessonDir, 'resources');
                                await fs.ensureDir(resourcesDir);

                                const resTasks = lessonData.resources.map(async (res) => {
                                    if (!res.downloadUrl) return null;

                                    if (res.isExternal) {
                                        logger.info(`    🔗 External resource linked: ${res.title}`);
                                        return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
                                    }

                                    try {
                                        updateStatus('Downloading resources...');
                                        const safeFileName = sanitizeName(res.file_name || res.title);
                                        const resPath = path.join(resourcesDir, safeFileName);

                                        if (fs.existsSync(resPath)) {
                                            const stats = fs.statSync(resPath);
                                            if (stats.size > 0) {
                                                logger.info(`    ⏭️  Resource already exists, skipping: ${res.title}`);
                                                return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                            }
                                        }

                                        logger.info(`    ⬇️  Downloading resource: ${res.title}`);
                                        await downloader.downloadAsset(res.downloadUrl, resPath);
                                        return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                    } catch (err) {
                                        logger.warn(`    ⚠️  Failed to download resource ${res.title}: ${String(err)}`);
                                        return null;
                                    }
                                });

                                const results = await Promise.all(resTasks);
                                results.forEach(r => { if (r) resourcesHtml.push(r); });
                            }

                            const isRootLesson = mInfo.moduleDirName.length === 0;
                            const groupLink = isRootLesson ? '../../index.html' : '../../../index.html';
                            const courseLink = isRootLesson ? '../index.html' : '../../index.html';
                            const moduleBreadcrumb = isRootLesson
                                ? ''
                                : `<span>/</span><span>${module.title}</span>`;

                            const htmlContent = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1">
                                <title>${lessonData.title}</title>
                                <style>
                                    :root {
                                        --bg: #f6f3ee;
                                        --panel: #ffffff;
                                        --panel-2: #f6f7fb;
                                        --text: #14161d;
                                        --muted: #5b6271;
                                        --accent: #3b82f6;
                                        --ring: rgba(20,22,29,0.08);
                                        --shadow: 0 16px 32px rgba(15, 23, 42, 0.12);
                                    }
                                    * { box-sizing: border-box; }
                                    body {
                                        margin: 0;
                                        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                                        background: linear-gradient(160deg, #fdfdfd 0%, #eff2fb 100%);
                                        color: var(--text);
                                        line-height: 1.7;
                                    }
                                    .page { max-width: 980px; margin: 48px auto 80px; padding: 0 22px; }
                                    .breadcrumb {
                                        font-size: 0.95rem;
                                        color: var(--muted);
                                        margin-bottom: 16px;
                                        display: flex;
                                        flex-wrap: wrap;
                                        gap: 8px;
                                        align-items: center;
                                    }
                                    .breadcrumb a { color: var(--accent); text-decoration: none; font-weight: 600; }
                                    .breadcrumb span { color: var(--muted); }
                                    .container {
                                        background: var(--panel);
                                        padding: 34px;
                                        border-radius: 20px;
                                        border: 1px solid rgba(20,22,29,0.05);
                                        box-shadow:
                                            0 25px 45px rgba(15, 23, 42, 0.18),
                                            0 10px 20px rgba(15, 23, 42, 0.08);
                                    }
                                    h1 { margin: 0 0 16px 0; font-size: clamp(1.8rem, 3vw, 2.6rem); }
                                    video {
                                        width: 100%;
                                        border-radius: 14px;
                                        margin: 10px 0 26px;
                                        display: block;
                                        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.2);
                                        background: #000;
                                    }
                                    img { max-width: 100%; border-radius: 10px; height: auto; margin: 14px 0; }
                                    .content { font-size: 1.05rem; }
                                    .content p { margin-bottom: 1.2em; }
                                    .resources {
                                        background: var(--panel-2);
                                        padding: 18px;
                                        border-radius: 14px;
                                        border: 1px solid var(--ring);
                                        margin-top: 28px;
                                    }
                                    .resources h3 { margin: 0 0 10px 0; color: var(--accent); }
                                    .resources ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
                                    .resources a {
                                        color: #1f3d7a;
                                        font-weight: 600;
                                        display: inline-flex;
                                        align-items: center;
                                        gap: 8px;
                                        text-decoration: none;
                                    }
                                    .resources a::before { content: "📁"; }
                                    a { color: var(--accent); text-decoration: none; word-break: break-word; }
                                    a:hover { text-decoration: underline; }
                                    .nav { margin-top: 28px; padding-top: 16px; border-top: 1px solid rgba(20,22,29,0.08); }
                                </style>
                            </head>
                            <body>
                                <div class="page">
                                    <div class="breadcrumb">
                                        <a href="${groupLink}">${groupName}</a>
                                        <span>/</span>
                                        <a href="${courseLink}">${courseName}</a>
                                        ${moduleBreadcrumb}
                                        <span>/</span>
                                        <span>${lessonData.title}</span>
                                    </div>
                                    <div class="container">
                                        <h1>${lessonData.title}</h1>
                                        ${hasVideo ? '<video controls src="video.mp4"></video>' : ''}
                                        <div class="content">
                                            ${localizedHtml}
                                        </div>
                                        ${resourcesHtml.length > 0 ? `
                                        <div class="resources">
                                            <h3>Resources / Attachments</h3>
                                            <ul>
                                                ${resourcesHtml.join('')}
                                            </ul>
                                        </div>
                                        ` : ''}
                                        <div class="nav">
                                            <a href="${courseLink}">Back to Course Index</a>
                                        </div>
                                    </div>
                                </div>
                            </body>
                            </html>
                        `;

                            await fs.writeFile(path.join(lessonDir, 'index.html'), htmlContent);

                            updateStatus('Saving metadata...');
                            const now = new Date().toISOString();
                            const firstDownloadedAt = oldManifest?.firstDownloadedAt ?? oldManifest?.updatedAt ?? now;
                            const lastCheckedAt = now;
                            const lastTextChangedAt =
                                isNewLesson || textChanged
                                    ? now
                                    : oldManifest?.lastTextChangedAt;
                            const lastVideoChangedAt =
                                videoChanged || videoWasNewlyDownloaded
                                    ? now
                                    : oldManifest?.lastVideoChangedAt;

                            // Carry forward any full fingerprint computed during video check.
                            // For new lessons without video, fullFingerprint stays undefined.
                            const fullFingerprintForManifest: FullFingerprint | undefined =
                                lastComputedFullFp ?? oldManifest?.fullFingerprint ?? undefined;

                            const lessonManifest: LessonManifest = {
                                lessonId: lesson.id,
                                title: lesson.title,
                                moduleIndex: mInfo.mIndex,
                                moduleTitle: mInfo.title,
                                lessonIndex: lIndex,
                                moduleDirName: mInfo.moduleDirName,
                                lessonDirName,
                                relativePath: mInfo.moduleDirName
                                    ? `${mInfo.moduleDirName}/${lessonDirName}/index.html`
                                    : `${lessonDirName}/index.html`,
                                hasVideo,
                                resourcesCount: resourcesHtml.length,
                                updatedAt: now,
                                contentHash: newContentHash,
                                videoFingerprint,
                                fullFingerprint: fullFingerprintForManifest,
                                firstDownloadedAt,
                                lastCheckedAt,
                                lastTextChangedAt,
                                lastVideoChangedAt
                            };

                            await writeAtomicJson(path.join(lessonDir, 'lesson.json'), lessonManifest);

                            const eventTypes: LessonEventType[] = [];
                            if (isNewLesson) eventTypes.push('lesson-added');
                            if (textChanged) eventTypes.push('text-updated');
                            if (videoChanged) eventTypes.push('video-updated');

                            let outcome: LessonOutcome = 'unchanged';
                            if (isNewLesson) outcome = 'new';
                            else if (textChanged && videoChanged) outcome = 'both-updated';
                            else if (textChanged) outcome = 'text-updated';
                            else if (videoChanged) outcome = 'video-updated';

                            if (isNewLesson) {
                                stats.textsNew += 1;
                                if (hasVideo) stats.videosNew += 1;
                            }
                            if (textChanged) stats.textsUpdated += 1;
                            if (videoChanged) stats.videosUpdated += 1;

                            const change: LessonChange = {
                                lessonId: lesson.id,
                                outcome,
                                relativePath: lessonManifest.relativePath,
                                title: lesson.title,
                                course: courseName,
                                moduleTitle: mInfo.title,
                                hasVideo,
                                events: eventTypes,
                                timestamps: {
                                    firstDownloadedAt,
                                    lastCheckedAt,
                                    lastTextChangedAt,
                                    lastVideoChangedAt
                                }
                            };
                            stats.changes.push(change);

                            completedLessons += 1;
                            options.callbacks?.onLessonComplete?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                hasVideo,
                                resourcesCount: resourcesHtml.length
                            });

                            updateStatus('Updating course index...');
                            indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }));
                        } catch (err) {
                            failedLessons += 1;
                            stats.failed += 1;
                            options.callbacks?.onLessonError?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                error: err
                            });
                            logger.error(`    ⚠️ Error processing lesson ${lesson.title}: ${String(err)}`);
                        }
                    }
                });
            }
        }

        if (options.runTasks) {
            await options.runTasks(tasks, concurrency);
        } else {
            await runConcurrent(tasks.map(task => () => task.run()), concurrency);
        }
        await indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }));
        const groupDir = activeGroupDir ?? path.dirname(baseOutputDir);
        await groupIndexLimit(() => regenerateGroupIndex(groupDir, { silent: options.suppressIndexLogs }));

        stats.endedAt = new Date().toISOString();
        try {
            await mergeRunIntoLog(groupDir, stats);
        } catch (err) {
            logger.warn(`⚠️ Failed to update group run log: ${String(err)}`);
        }
        // Re-run group index so chips/badges reflect this run's fresh timestamps.
        await groupIndexLimit(() => regenerateGroupIndex(groupDir, { silent: options.suppressIndexLogs }));

        const summary: DownloadSummary = {
            courseName,
            groupName,
            outputDir: baseOutputDir,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            completedLessons,
            failedLessons,
            targetLessonId
        };

        options.callbacks?.onCourseComplete?.(summary);

        printRunReport(stats, logger);

        return summary;
    } finally {
        await scraper.close();
    }
}
