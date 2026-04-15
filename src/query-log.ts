import path from 'path';
import { readGroupLog, type LessonEvent, type RunSummary } from './run-log.js';
import type { Logger } from './logger.js';

export type QueryOptions = {
    since?: string;
    last?: number;
    latest?: boolean;
    json?: boolean;
};

function parseSince(value: string | undefined): number | null {
    if (!value) return null;
    const rel = value.match(/^(\d+)([dhm])$/);
    if (rel) {
        const n = parseInt(rel[1], 10);
        const unit = rel[2];
        const ms =
            unit === 'd' ? 86400000
            : unit === 'h' ? 3600000
            : 60000;
        return Date.now() - n * ms;
    }
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.getTime();
    return null;
}

function eventLabel(type: LessonEvent['type']): string {
    switch (type) {
        case 'lesson-added':
            return 'NEW   ';
        case 'text-updated':
            return 'TEXT  ';
        case 'video-updated':
            return 'VIDEO ';
        case 'resource-added':
            return 'RES+  ';
        case 'resource-removed':
            return 'RES-  ';
        default:
            return '?     ';
    }
}

export async function queryGroupLog(
    groupDir: string,
    opts: QueryOptions,
    logger: Logger
): Promise<void> {
    const log = await readGroupLog(groupDir);
    if (!log) {
        logger.error(`❌ No log found at ${path.join(groupDir, '.group-log.json')}`);
        process.exit(1);
    }

    const allEvents = log.events;
    const allRuns = log.runs;

    let filteredEvents = allEvents;
    let filteredRuns = allRuns;
    let headline = `What's new in "${log.groupName}" (latest run)`;

    const sinceMs = parseSince(opts.since);
    if (opts.since && sinceMs === null) {
        logger.error(`❌ Invalid --since value: ${opts.since}`);
        process.exit(1);
    }

    if (sinceMs !== null) {
        filteredEvents = allEvents.filter(e => {
            const t = Date.parse(e.ts);
            return !isNaN(t) && t >= sinceMs;
        });
        const runSet = new Set(filteredEvents.map(e => e.runId));
        filteredRuns = allRuns.filter(r => runSet.has(r.runId));
        headline = `What's new in "${log.groupName}" (since ${new Date(sinceMs).toISOString()})`;
    } else if (typeof opts.last === 'number' && opts.last > 0) {
        const lastN = allRuns.slice(-opts.last);
        const idSet = new Set(lastN.map(r => r.runId));
        filteredRuns = lastN;
        filteredEvents = allEvents.filter(e => idSet.has(e.runId));
        headline = `What's new in "${log.groupName}" (last ${opts.last} run${opts.last === 1 ? '' : 's'})`;
    } else {
        const latest = allRuns[allRuns.length - 1];
        if (latest) {
            filteredRuns = [latest];
            filteredEvents = allEvents.filter(e => e.runId === latest.runId);
        } else {
            filteredRuns = [];
            filteredEvents = [];
        }
    }

    if (opts.json) {
        logger.info(JSON.stringify({ events: filteredEvents, runs: filteredRuns }, null, 2));
        return;
    }

    logger.info(headline);
    logger.info('');

    if (filteredRuns.length === 0) {
        logger.info('No runs recorded yet.');
        return;
    }

    for (const run of filteredRuns) {
        const runEvents = filteredEvents.filter(e => e.runId === run.runId);
        logger.info(
            `Run ${run.runId} (${run.startedAt}): ${run.videosUpdated} videos updated, ${run.textsUpdated} texts updated, ${run.videosNew + run.textsNew} new, ${run.failed} failed`
        );
        if (runEvents.length === 0) {
            logger.info('  (no lesson-level events)');
        } else {
            for (const evt of runEvents) {
                const label = eventLabel(evt.type);
                const title = evt.title ? `  —  ${evt.title}` : '';
                logger.info(`  ${label} ${evt.course}/${evt.relativePath}${title}`);
            }
        }
        logger.info('');
    }
}
