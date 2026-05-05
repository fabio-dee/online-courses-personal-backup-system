import crypto from 'crypto';

const RE_SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const RE_STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const RE_VIEW_COUNT = /\d+\s+(?:views?|members?)/gi;
const RE_REL_TIMESTAMP = /\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago/gi;
const RE_WHITESPACE = /\s+/g;

export function bodyHash(html: string): string {
    const cleaned = html
        .replace(RE_SCRIPT, ' ')
        .replace(RE_STYLE, ' ')
        .replace(RE_VIEW_COUNT, ' ')
        .replace(RE_REL_TIMESTAMP, ' ')
        .replace(RE_WHITESPACE, ' ')
        .trim()
        .normalize('NFC');

    return crypto.createHash('sha256').update(cleaned).digest('hex');
}
