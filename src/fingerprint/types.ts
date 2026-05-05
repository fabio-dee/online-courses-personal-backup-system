import type { PerceptualFingerprint } from './perceptual/types.js';
export type { PerceptualFingerprint } from './perceptual/types.js';

export type FfprobeFingerprint = {
    durationMs: number;
    nbStreams: number;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    bitRate: number | null;
};

export type ChunkHashes = {
    first: string;
    middle: string | null;
    last: string | null;
    fileSize: number;
};

export type FullFingerprint = {
    fp_schema: 2;
    playbackId?: string;
    ffprobe: FfprobeFingerprint | null;
    chunks: ChunkHashes | null;
    bodyHash: string | null;
    /** Phase 3 perceptual data. Present after escalation runs. Null means escalation
     *  was attempted but produced no data; undefined means it was never run. */
    perceptual?: PerceptualFingerprint | null;
};

export type SignalName =
    | 'playbackId'
    | 'durationMs'
    | 'codecDims'
    | 'chunkFirst'
    | 'chunkMiddle'
    | 'chunkLast';

export type SignalVerdict = 'match' | 'near' | 'mismatch' | 'unknown';

export type SignalReport = {
    signal: SignalName;
    verdict: SignalVerdict;
    weight: number;
    detail?: string;
};

export type VideoState = 'UNCHANGED' | 'REPLACED' | 'MINOR_CHANGE' | 'UNKNOWN';
export type BodyState = 'UNCHANGED' | 'MINOR';

export type VideoVerdict = {
    state: VideoState;
    score: number;
    signals: SignalReport[];
};
