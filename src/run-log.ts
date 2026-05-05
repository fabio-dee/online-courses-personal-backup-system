import fs from 'fs-extra';
import path from 'path';

export const EVENT_CAP = 1000;
export const RUN_CAP = 50;

export type LessonEventType =
    | 'lesson-added'
    | 'text-updated'
    | 'video-updated'
    | 'resource-added'
    | 'resource-removed';

export type LessonEvent = {
    ts: string;
    runId: string;
    lessonId: string;
    type: LessonEventType;
    course: string;
    relativePath: string;
    title?: string;
};

export type RunSummary = {
    runId: string;
    startedAt: string;
    endedAt: string;
    courseName: string;
    mode: string;
    update: boolean;
    videosChecked: number;
    videosNew: number;
    videosUpdated: number;
    textsChecked: number;
    textsNew: number;
    textsUpdated: number;
    failed: number;
};

export type LessonLogEntry = {
    relativePath: string;
    courseName: string;
    moduleTitle: string;
    title: string;
    firstDownloadedAt?: string;
    lastCheckedAt?: string;
    lastTextChangedAt?: string;
    lastVideoChangedAt?: string;
};

export type GroupLog = {
    schemaVersion: 1;
    /** Fingerprint schema version. Present when fp_schema=2 data has been written. */
    fp_schema?: 2;
    groupName: string;
    lessons: Record<string, LessonLogEntry>;
    events: LessonEvent[];
    runs: RunSummary[];
};

export type LessonOutcome =
    | 'new'
    | 'video-updated'
    | 'text-updated'
    | 'both-updated'
    | 'unchanged'
    | 'failed';

export type LessonChangeTimestamps = {
    firstDownloadedAt?: string;
    lastCheckedAt?: string;
    lastTextChangedAt?: string;
    lastVideoChangedAt?: string;
};

export type LessonChange = {
    lessonId: string;
    outcome: LessonOutcome;
    relativePath: string;
    title: string;
    course: string;
    moduleTitle: string;
    hasVideo: boolean;
    events: LessonEventType[];
    timestamps: LessonChangeTimestamps;
};

export type RunStats = {
    runId: string;
    startedAt: string;
    endedAt?: string;
    courseName: string;
    groupName: string;
    mode: string;
    update: boolean;
    videosChecked: number;
    videosNew: number;
    videosUpdated: number;
    textsChecked: number;
    textsNew: number;
    textsUpdated: number;
    failed: number;
    changes: LessonChange[];
};

export function newRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createRunStats(meta: {
    courseName: string;
    groupName: string;
    mode: string;
    update: boolean;
}): RunStats {
    return {
        runId: newRunId(),
        startedAt: new Date().toISOString(),
        courseName: meta.courseName,
        groupName: meta.groupName,
        mode: meta.mode,
        update: meta.update,
        videosChecked: 0,
        videosNew: 0,
        videosUpdated: 0,
        textsChecked: 0,
        textsNew: 0,
        textsUpdated: 0,
        failed: 0,
        changes: []
    };
}

async function writeAtomicJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
}

function groupLogPath(groupDir: string) {
    return path.join(groupDir, '.group-log.json');
}

export async function readGroupLog(groupDir: string): Promise<GroupLog | null> {
    const filePath = groupLogPath(groupDir);
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = await fs.readJson(filePath);
        if (typeof data !== 'object' || data === null) return null;
        if (data.schemaVersion !== 1) {
            console.warn(`⚠️ .group-log.json at ${filePath} has unknown schemaVersion ${data.schemaVersion}; ignoring.`);
            return null;
        }
        return {
            schemaVersion: 1,
            groupName: data.groupName ?? path.basename(groupDir),
            lessons: data.lessons ?? {},
            events: Array.isArray(data.events) ? data.events : [],
            runs: Array.isArray(data.runs) ? data.runs : []
        } as GroupLog;
    } catch (err) {
        console.warn(`⚠️ Failed to parse .group-log.json at ${filePath}: ${String(err)}`);
        return null;
    }
}

export async function mergeRunIntoLog(groupDir: string, stats: RunStats): Promise<void> {
    await fs.ensureDir(groupDir);

    const existing = await readGroupLog(groupDir);
    const log: GroupLog = existing ?? {
        schemaVersion: 1,
        fp_schema: 2,
        groupName: stats.groupName,
        lessons: {},
        events: [],
        runs: []
    };
    // Always stamp fp_schema=2 so readers know full fingerprints may be present.
    log.fp_schema = 2;

    if (!log.groupName) {
        log.groupName = stats.groupName;
    }

    const endedAt = stats.endedAt ?? new Date().toISOString();

    for (const change of stats.changes) {
        const existingEntry = log.lessons[change.lessonId];
        const merged: LessonLogEntry = {
            relativePath: change.relativePath,
            courseName: change.course,
            moduleTitle: change.moduleTitle,
            title: change.title,
            firstDownloadedAt:
                existingEntry?.firstDownloadedAt
                ?? change.timestamps.firstDownloadedAt,
            lastCheckedAt: change.timestamps.lastCheckedAt ?? endedAt,
            lastTextChangedAt:
                change.timestamps.lastTextChangedAt
                ?? existingEntry?.lastTextChangedAt,
            lastVideoChangedAt:
                change.timestamps.lastVideoChangedAt
                ?? existingEntry?.lastVideoChangedAt
        };
        log.lessons[change.lessonId] = merged;

        for (const type of change.events) {
            log.events.push({
                ts: endedAt,
                runId: stats.runId,
                lessonId: change.lessonId,
                type,
                course: change.course,
                relativePath: change.relativePath,
                title: change.title
            });
        }
    }

    if (log.events.length > EVENT_CAP) {
        log.events = log.events.slice(log.events.length - EVENT_CAP);
    }

    const runSummary: RunSummary = {
        runId: stats.runId,
        startedAt: stats.startedAt,
        endedAt,
        courseName: stats.courseName,
        mode: stats.mode,
        update: stats.update,
        videosChecked: stats.videosChecked,
        videosNew: stats.videosNew,
        videosUpdated: stats.videosUpdated,
        textsChecked: stats.textsChecked,
        textsNew: stats.textsNew,
        textsUpdated: stats.textsUpdated,
        failed: stats.failed
    };
    log.runs.push(runSummary);
    if (log.runs.length > RUN_CAP) {
        log.runs = log.runs.slice(log.runs.length - RUN_CAP);
    }

    await writeAtomicJson(groupLogPath(groupDir), log);
}

/**
 * Idempotently stamp fp_schema=2 onto the group log and append a synthetic
 * refingerprint run entry so future --update runs see a current fp_schema.
 * Called by runRefingerprint after scanning all lessons (P0-5 fix).
 */
export async function stampFpSchema(groupDir: string): Promise<void> {
    await fs.ensureDir(groupDir);
    const existing = await readGroupLog(groupDir);
    const log: GroupLog = existing ?? {
        schemaVersion: 1,
        fp_schema: 2,
        groupName: path.basename(groupDir),
        lessons: {},
        events: [],
        runs: []
    };
    log.fp_schema = 2;

    const now = new Date().toISOString();
    const runSummary: RunSummary = {
        runId: newRunId(),
        startedAt: now,
        endedAt: now,
        courseName: '',
        mode: 'refingerprint',
        update: false,
        videosChecked: 0,
        videosNew: 0,
        videosUpdated: 0,
        textsChecked: 0,
        textsNew: 0,
        textsUpdated: 0,
        failed: 0
    };
    log.runs.push(runSummary);
    if (log.runs.length > RUN_CAP) {
        log.runs = log.runs.slice(log.runs.length - RUN_CAP);
    }

    await writeAtomicJson(groupLogPath(groupDir), log);
}

function formatList(changes: LessonChange[], predicate: (c: LessonChange) => boolean): string[] {
    return changes.filter(predicate).map(c => c.relativePath);
}

function formatBulletSection(label: string, paths: string[]): string {
    if (paths.length === 0) return `    • 0 ${label}`;
    const [first, ...rest] = paths;
    const lines = [`    • ${paths.length} ${label}: ${first}`];
    for (const p of rest) {
        lines.push(`                  ${p}`);
    }
    return lines.join('\n');
}

export function printRunReport(stats: RunStats, logger: { info(msg: string): void }): void {
    const totalChanges =
        stats.videosNew + stats.videosUpdated + stats.textsNew + stats.textsUpdated;

    logger.info('');
    logger.info(`📊 Report for ${stats.groupName} / ${stats.courseName}`);

    if (totalChanges === 0 && stats.failed === 0) {
        logger.info(
            `  ${stats.videosChecked} videos, ${stats.textsChecked} lesson texts checked — no changes.`
        );
        logger.info('');
        logger.info(`  Full log:  downloads/${stats.groupName}/.group-log.json`);
        logger.info(`  Hint:      skool log downloads/${stats.groupName} --latest`);
        return;
    }

    const videoNewPaths = formatList(
        stats.changes,
        c => c.hasVideo && c.events.includes('lesson-added')
    );
    const videoUpdatedPaths = formatList(
        stats.changes,
        c => c.events.includes('video-updated')
    );
    const textNewPaths = formatList(
        stats.changes,
        c => c.events.includes('lesson-added')
    );
    const textUpdatedPaths = formatList(
        stats.changes,
        c => c.events.includes('text-updated')
    );

    const unchanged =
        stats.videosChecked + stats.textsChecked
        - stats.videosNew
        - stats.videosUpdated
        - stats.textsNew
        - stats.textsUpdated;

    logger.info(`  ${stats.videosChecked} videos checked:`);
    logger.info(formatBulletSection('new', videoNewPaths));
    logger.info(formatBulletSection('updated', videoUpdatedPaths));
    logger.info(`  ${stats.textsChecked} lesson texts checked:`);
    logger.info(formatBulletSection('new', textNewPaths));
    logger.info(formatBulletSection('updated', textUpdatedPaths));
    logger.info(`  (${Math.max(0, unchanged)} unchanged, ${stats.failed} failed)`);
    logger.info('');
    logger.info(`  Full log:  downloads/${stats.groupName}/.group-log.json`);
    logger.info(`  Hint:      skool log downloads/${stats.groupName} --latest`);
}
