import fs from 'fs/promises';
import crypto from 'crypto';
import type { ChunkHashes } from './types.js';

const CHUNK_SIZE = 1024 * 1024; // 1 MB

async function hashRange(
    fd: fs.FileHandle,
    offset: number,
    length: number,
): Promise<string> {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fd.read(buf, 0, length, offset);
    return crypto
        .createHash('sha256')
        .update(buf.subarray(0, bytesRead))
        .digest('hex');
}

export async function chunkHashes(path: string): Promise<ChunkHashes> {
    const stat = await fs.stat(path);
    const fileSize = stat.size;

    const fd = await fs.open(path, 'r');
    try {
        if (fileSize < CHUNK_SIZE) {
            // Hash the whole file as "first"; middle and last are null.
            const first = await hashRange(fd, 0, fileSize);
            return { first, middle: null, last: null, fileSize };
        }

        const first = await hashRange(fd, 0, CHUNK_SIZE);

        const middleOffset = Math.max(0, Math.floor(fileSize / 2) - CHUNK_SIZE / 2);
        const middle = await hashRange(fd, middleOffset, CHUNK_SIZE);

        const lastOffset = Math.max(0, fileSize - CHUNK_SIZE);
        const last = await hashRange(fd, lastOffset, CHUNK_SIZE);

        return { first, middle, last, fileSize };
    } finally {
        await fd.close();
    }
}
