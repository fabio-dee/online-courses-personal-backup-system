import type {
    FullFingerprint,
    SignalReport,
    SignalVerdict,
    VideoVerdict,
    VideoState,
    BodyState,
} from './types.js';

// Duration thresholds (milliseconds)
const DURATION_MATCH_MS = 100;
const DURATION_NEAR_MS = 2000;

// Weights per signal
const WEIGHT_PLAYBACK = 2;
const WEIGHT_DURATION = 4;
const WEIGHT_CODEC_DIMS = 1;
const WEIGHT_CHUNK = 3; // per chunk; 3 chunks × 3 = 9 total

// Thresholds
const SCORE_UNCHANGED_HIGH = 12;
const SCORE_UNCHANGED_WITH_DURATION = 8;

function sig(
    signal: SignalReport['signal'],
    verdict: SignalVerdict,
    weight: number,
    detail?: string,
): SignalReport {
    return { signal, verdict, weight, detail };
}

export function scoreVideo(
    prior: FullFingerprint,
    current: FullFingerprint,
): VideoVerdict {
    const reports: SignalReport[] = [];
    let score = 0;
    let hasDurationMismatch = false;
    let hasFfprobeNull = !prior.ffprobe || !current.ffprobe;

    // --- L1: playback ID ---
    if (prior.playbackId && current.playbackId) {
        if (prior.playbackId === current.playbackId) {
            reports.push(sig('playbackId', 'match', WEIGHT_PLAYBACK));
            score += WEIGHT_PLAYBACK;
        } else {
            reports.push(sig('playbackId', 'mismatch', WEIGHT_PLAYBACK,
                `${prior.playbackId} → ${current.playbackId}`));
        }
    } else {
        reports.push(sig('playbackId', 'unknown', WEIGHT_PLAYBACK, 'missing on one side'));
    }

    // --- L2: ffprobe signals ---
    if (prior.ffprobe && current.ffprobe) {
        const deltaDuration = Math.abs(prior.ffprobe.durationMs - current.ffprobe.durationMs);
        let durationVerdict: SignalVerdict;
        if (deltaDuration <= DURATION_MATCH_MS) {
            durationVerdict = 'match';
            score += WEIGHT_DURATION;
        } else if (deltaDuration <= DURATION_NEAR_MS) {
            durationVerdict = 'near';
            score += Math.floor(WEIGHT_DURATION / 2);
        } else {
            durationVerdict = 'mismatch';
            hasDurationMismatch = true;
        }
        reports.push(sig('durationMs', durationVerdict, WEIGHT_DURATION,
            `Δ${deltaDuration}ms`));

        const codecMatch =
            prior.ffprobe.videoCodec === current.ffprobe.videoCodec &&
            prior.ffprobe.audioCodec === current.ffprobe.audioCodec &&
            prior.ffprobe.width === current.ffprobe.width &&
            prior.ffprobe.height === current.ffprobe.height;
        if (codecMatch) {
            reports.push(sig('codecDims', 'match', WEIGHT_CODEC_DIMS));
            score += WEIGHT_CODEC_DIMS;
        } else {
            reports.push(sig('codecDims', 'mismatch', WEIGHT_CODEC_DIMS,
                `${prior.ffprobe.videoCodec}/${prior.ffprobe.width}x${prior.ffprobe.height}` +
                ` → ${current.ffprobe.videoCodec}/${current.ffprobe.width}x${current.ffprobe.height}`));
        }
    } else {
        reports.push(sig('durationMs', 'unknown', WEIGHT_DURATION, 'ffprobe null'));
        reports.push(sig('codecDims', 'unknown', WEIGHT_CODEC_DIMS, 'ffprobe null'));
    }

    // --- L3: chunk hashes ---
    const chunkSignals: Array<{ name: SignalReport['signal']; p: string | null; c: string | null }> = [
        { name: 'chunkFirst', p: prior.chunks?.first ?? null, c: current.chunks?.first ?? null },
        { name: 'chunkMiddle', p: prior.chunks?.middle ?? null, c: current.chunks?.middle ?? null },
        { name: 'chunkLast', p: prior.chunks?.last ?? null, c: current.chunks?.last ?? null },
    ];

    for (const { name, p, c } of chunkSignals) {
        if (p === null || c === null) {
            reports.push(sig(name, 'unknown', WEIGHT_CHUNK, 'not available'));
        } else if (p === c) {
            reports.push(sig(name, 'match', WEIGHT_CHUNK));
            score += WEIGHT_CHUNK;
        } else {
            reports.push(sig(name, 'mismatch', WEIGHT_CHUNK));
        }
    }

    // --- Verdict ---
    let state: VideoState;

    if (hasFfprobeNull) {
        state = 'UNKNOWN';
    } else if (hasDurationMismatch) {
        state = 'REPLACED';
    } else if (score >= SCORE_UNCHANGED_HIGH) {
        state = 'UNCHANGED';
    } else if (score >= SCORE_UNCHANGED_WITH_DURATION) {
        // Only if duration was match/near (no mismatch already guarded above)
        const durationRep = reports.find(r => r.signal === 'durationMs');
        if (durationRep && (durationRep.verdict === 'match' || durationRep.verdict === 'near')) {
            state = 'UNCHANGED';
        } else {
            state = 'MINOR_CHANGE';
        }
    } else {
        // Check if chunks differ but playback + duration matched
        const chunkMismatches = reports.filter(
            r => (r.signal === 'chunkFirst' || r.signal === 'chunkMiddle' || r.signal === 'chunkLast') &&
                r.verdict === 'mismatch'
        ).length;
        const playbackMatch = reports.find(r => r.signal === 'playbackId')?.verdict === 'match';
        const durationMatch = reports.find(r => r.signal === 'durationMs')?.verdict === 'match';
        if (chunkMismatches > 0 && playbackMatch && durationMatch) {
            state = 'MINOR_CHANGE';
        } else {
            state = 'MINOR_CHANGE';
        }
    }

    return { state, score, signals: reports };
}

export function scoreBody(priorHash: string | null, currentHash: string | null): BodyState {
    if (priorHash === null || currentHash === null) return 'MINOR';
    return priorHash === currentHash ? 'UNCHANGED' : 'MINOR';
}
