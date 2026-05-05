import { spawn } from 'child_process';
import type { FfprobeFingerprint } from './types.js';

const TIMEOUT_MS = 10_000;

type FfprobeJson = {
    format?: {
        duration?: string;
        bit_rate?: string;
        nb_streams?: number;
    };
    streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
    }>;
};

export async function probeVideo(path: string): Promise<FfprobeFingerprint | null> {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            path,
        ];

        const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
            resolve(null);
        }, TIMEOUT_MS);

        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return;
            if (code !== 0) {
                resolve(null);
                return;
            }
            try {
                const data = JSON.parse(stdout) as FfprobeJson;
                const fmt = data.format ?? {};
                const streams = data.streams ?? [];

                const durationMs = fmt.duration != null
                    ? Math.round(parseFloat(fmt.duration) * 1000)
                    : 0;
                const nbStreams = fmt.nb_streams ?? streams.length;
                const bitRate = fmt.bit_rate != null ? parseInt(fmt.bit_rate, 10) : null;

                let videoCodec: string | null = null;
                let audioCodec: string | null = null;
                let width: number | null = null;
                let height: number | null = null;

                for (const s of streams) {
                    if (s.codec_type === 'video' && videoCodec === null) {
                        videoCodec = s.codec_name ?? null;
                        width = s.width ?? null;
                        height = s.height ?? null;
                    }
                    if (s.codec_type === 'audio' && audioCodec === null) {
                        audioCodec = s.codec_name ?? null;
                    }
                }

                resolve({ durationMs, nbStreams, videoCodec, audioCodec, width, height, bitRate });
            } catch {
                resolve(null);
            }
        });

        proc.on('error', () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}
