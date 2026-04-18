#!/usr/bin/env tsx
/**
 * Scan a downloaded course tree for "empty" lessons — no video, empty body —
 * and delete their lesson.json manifests so the next downloader run re-scrapes
 * them. Useful after adding the pinned-post fallback in scraper.ts, to force
 * re-processing of lessons that were previously silently empty.
 *
 * Usage:
 *   tsx src/rescrape-empty-lessons.ts <downloadsRoot> [--yes]
 *
 * Example:
 *   tsx src/rescrape-empty-lessons.ts downloads/makerschool           # dry run
 *   tsx src/rescrape-empty-lessons.ts downloads/makerschool --yes     # actually delete
 */

import fs from 'fs';
import path from 'path';

interface LessonManifestLite {
    hasVideo?: boolean;
    resourcesCount?: number;
    title?: string;
    lessonId?: string;
}

function walk(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name === 'assets' || e.name === 'resources') continue;
            walk(full, out);
        } else if (e.isFile() && e.name === 'lesson.json') {
            out.push(full);
        }
    }
    return out;
}

function extractBody(html: string): string {
    // Grab <div class="content">...</div> (first occurrence, non-greedy)
    const m = html.match(/<div\s+class="content"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/div>)/i);
    const inner = m ? m[1] : html;
    // Strip all tags and whitespace
    return inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
}

function main() {
    const args = process.argv.slice(2);
    const yes = args.includes('--yes');
    const root = args.find(a => !a.startsWith('--'));
    if (!root) {
        console.error('Usage: tsx src/rescrape-empty-lessons.ts <downloadsRoot> [--yes]');
        process.exit(1);
    }
    const absRoot = path.resolve(root);
    if (!fs.existsSync(absRoot)) {
        console.error(`Not found: ${absRoot}`);
        process.exit(1);
    }

    const manifests = walk(absRoot);
    const candidates: { manifestPath: string; title: string; lessonId: string; htmlPath: string }[] = [];

    for (const mPath of manifests) {
        let manifest: LessonManifestLite;
        try {
            manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        } catch {
            continue;
        }
        if (manifest.hasVideo !== false) continue;
        if ((manifest.resourcesCount ?? 0) > 0) continue;

        const lessonDir = path.dirname(mPath);
        const htmlPath = path.join(lessonDir, 'index.html');
        if (!fs.existsSync(htmlPath)) continue;

        let html: string;
        try {
            html = fs.readFileSync(htmlPath, 'utf8');
        } catch {
            continue;
        }

        const bodyText = extractBody(html);
        if (bodyText.length > 0) continue;

        candidates.push({
            manifestPath: mPath,
            title: manifest.title || '(untitled)',
            lessonId: manifest.lessonId || '',
            htmlPath
        });
    }

    if (candidates.length === 0) {
        console.log(`✅ No empty lessons found under ${absRoot}`);
        return;
    }

    console.log(`Found ${candidates.length} empty lesson(s) under ${absRoot}:`);
    for (const c of candidates) {
        console.log(`  - ${c.title}  [${c.lessonId}]`);
        console.log(`    ${path.relative(absRoot, c.manifestPath)}`);
    }

    if (!yes) {
        console.log(`\nDry run. Re-run with --yes to delete the lesson.json files and force re-scrape.`);
        return;
    }

    let deleted = 0;
    for (const c of candidates) {
        try {
            fs.unlinkSync(c.manifestPath);
            deleted += 1;
        } catch (e) {
            console.warn(`  ⚠️ Failed to delete ${c.manifestPath}: ${String(e)}`);
        }
    }
    console.log(`\n🗑  Deleted ${deleted}/${candidates.length} lesson.json manifest(s). Re-run the downloader to re-scrape.`);
}

main();
