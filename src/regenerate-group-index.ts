import fs from 'fs-extra';
import path from 'path';

type CourseManifest = {
    courseName: string;
    groupName: string;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
    }>;
    updatedAt: string;
};

type GroupIndexCourse = {
    dirName: string;
    courseName: string;
    groupName?: string;
    courseImagePath?: string;
    modulesCount: number;
    lessonsCount: number;
    updatedAt?: string;
    newCount: number;
    updatedCount: number;
    lastChangedAt?: string;
};

type GroupLogLessonEntry = {
    relativePath?: string;
    courseName?: string;
    firstDownloadedAt?: string;
    lastTextChangedAt?: string;
    lastVideoChangedAt?: string;
};

type GroupLogShape = {
    schemaVersion?: number;
    runs?: Array<{ endedAt?: string }>;
    lessons?: Record<string, GroupLogLessonEntry>;
};

async function readGroupLogRaw(groupDir: string): Promise<GroupLogShape | null> {
    const logPath = path.join(groupDir, '.group-log.json');
    if (!fs.existsSync(logPath)) return null;
    try {
        const data = await fs.readJson(logPath);
        if (data && typeof data === 'object') return data as GroupLogShape;
        return null;
    } catch {
        return null;
    }
}

function resolveWindowStartMs(log: GroupLogShape | null): number {
    const fallback = Date.now() - 7 * 86400000;
    if (!log || !Array.isArray(log.runs) || log.runs.length < 2) return fallback;
    const prev = log.runs[log.runs.length - 2];
    const prevMs = prev?.endedAt ? Date.parse(prev.endedAt) : NaN;
    return isNaN(prevMs) ? fallback : prevMs;
}

function latestIso(values: Array<string | undefined>): string | undefined {
    const filtered = values.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (filtered.length === 0) return undefined;
    return filtered.reduce((a, b) => (a > b ? a : b));
}

function aggregateCourseFreshness(
    log: GroupLogShape | null,
    courseName: string,
    windowStartMs: number
): { newCount: number; updatedCount: number; lastChangedAt?: string } {
    if (!log || !log.lessons) return { newCount: 0, updatedCount: 0 };
    let newCount = 0;
    let updatedCount = 0;
    let lastChanged: string | undefined;
    for (const entry of Object.values(log.lessons)) {
        if ((entry.courseName ?? '') !== courseName) continue;
        const firstMs = entry.firstDownloadedAt ? Date.parse(entry.firstDownloadedAt) : NaN;
        const textMs = entry.lastTextChangedAt ? Date.parse(entry.lastTextChangedAt) : NaN;
        const videoMs = entry.lastVideoChangedAt ? Date.parse(entry.lastVideoChangedAt) : NaN;
        const isNew = !isNaN(firstMs) && firstMs >= windowStartMs;
        const latest = Math.max(isNaN(textMs) ? 0 : textMs, isNaN(videoMs) ? 0 : videoMs);
        const isUpdated = !isNew && latest >= windowStartMs;
        if (isNew) newCount += 1;
        if (isUpdated) updatedCount += 1;
        const entryLatest = latestIso([
            entry.firstDownloadedAt,
            entry.lastTextChangedAt,
            entry.lastVideoChangedAt
        ]);
        if (entryLatest && (!lastChanged || entryLatest > lastChanged)) {
            lastChanged = entryLatest;
        }
    }
    return { newCount, updatedCount, lastChangedAt: lastChanged };
}

type RegenerateOptions = {
    silent?: boolean;
};

async function writeAtomicHtml(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

async function countLessons(coursePath: string) {
    let modulesCount = 0;
    let lessonsCount = 0;

    const moduleEntries = await fs.readdir(coursePath, { withFileTypes: true });
    const moduleDirs: typeof moduleEntries = [];
    const rootLessonDirs: typeof moduleEntries = [];

    for (const entry of moduleEntries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'assets') continue;
        const entryPath = path.join(coursePath, entry.name);
        const indexPath = path.join(entryPath, 'index.html');
        const manifestPath = path.join(entryPath, 'lesson.json');
        if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
            rootLessonDirs.push(entry);
        } else {
            moduleDirs.push(entry);
        }
    }

    modulesCount = moduleDirs.length + (rootLessonDirs.length > 0 ? 1 : 0);

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(coursePath, moduleDir.name);
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
                lessonsCount += 1;
            }
        }
    }

    for (const lessonDir of rootLessonDirs) {
        const lessonPath = path.join(coursePath, lessonDir.name);
        const indexPath = path.join(lessonPath, 'index.html');
        const manifestPath = path.join(lessonPath, 'lesson.json');
        if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
            lessonsCount += 1;
        }
    }

    return { modulesCount, lessonsCount };
}

async function loadCourseInfo(
    coursePath: string,
    dirName: string,
    log: GroupLogShape | null,
    windowStartMs: number
): Promise<GroupIndexCourse | null> {
    const manifestPath = path.join(coursePath, '.course.json');
    let manifest: CourseManifest | null = null;
    if (await fs.pathExists(manifestPath)) {
        try {
            manifest = await fs.readJson(manifestPath);
        } catch {
            manifest = null;
        }
    }

    const courseName = manifest?.courseName || dirName;
    const groupName = manifest?.groupName;
    const courseImagePath = manifest?.courseImagePath;
    const counts = await countLessons(coursePath);
    const freshness = aggregateCourseFreshness(log, courseName, windowStartMs);

    return {
        dirName,
        courseName,
        groupName,
        courseImagePath,
        modulesCount: counts.modulesCount,
        lessonsCount: counts.lessonsCount,
        updatedAt: manifest?.updatedAt,
        newCount: freshness.newCount,
        updatedCount: freshness.updatedCount,
        lastChangedAt: freshness.lastChangedAt
    };
}

async function regenerateGroupIndex(
    groupDir: string,
    options: RegenerateOptions = {}
) {
    const log = options.silent ? () => {} : console.log;
    const warn = options.silent ? () => {} : console.warn;

    if (!fs.existsSync(groupDir)) {
        log(`Group directory not found: ${groupDir}`);
        return;
    }

    const entries = await fs.readdir(groupDir, { withFileTypes: true });
    const courseDirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    const groupLog = await readGroupLogRaw(groupDir);
    const windowStartMs = resolveWindowStartMs(groupLog);

    const courses: GroupIndexCourse[] = [];
    let resolvedGroupName: string | null = null;

    for (const courseDir of courseDirs) {
        const coursePath = path.join(groupDir, courseDir.name);
        const courseInfo = await loadCourseInfo(coursePath, courseDir.name, groupLog, windowStartMs);
        if (!courseInfo) continue;

        courses.push(courseInfo);
        if (!resolvedGroupName && courseInfo.groupName) {
            resolvedGroupName = courseInfo.groupName;
        }
    }

    if (courses.length === 0) {
        warn('No courses found to build group index.');
        return;
    }

    const groupName = resolvedGroupName || path.basename(groupDir);

    courses.sort((a, b) => {
        if (a.updatedAt && b.updatedAt) {
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }
        return a.courseName.localeCompare(b.courseName);
    });

    const totalLessons = courses.reduce((acc, course) => acc + course.lessonsCount, 0);

    const courseCards = await Promise.all(
        courses.map(async (course) => {
            const coursePath = path.join(groupDir, course.dirName);
            const courseIndexPath = `${course.dirName}/index.html`;
            let imageMarkup = '<div class="course-fallback">No course image</div>';

            if (course.courseImagePath) {
                const resolvedImagePath = path.join(coursePath, course.courseImagePath);
                if (await fs.pathExists(resolvedImagePath)) {
                    const imageSrc = `${course.dirName}/${course.courseImagePath}`;
                    imageMarkup = `<img src="${imageSrc}" alt="${course.courseName} cover">`;
                }
            }

            const updatedLabel = course.updatedAt
                ? new Date(course.updatedAt).toLocaleDateString()
                : 'Unknown';

            const chips: string[] = [];
            if (course.newCount > 0) {
                chips.push(`<span class="freshness-chip freshness-chip-new">+${course.newCount} new</span>`);
            }
            if (course.updatedCount > 0) {
                chips.push(`<span class="freshness-chip freshness-chip-updated">${course.updatedCount} updated</span>`);
            }
            const chipHtml = chips.length > 0 ? `<div class="freshness-chips">${chips.join('')}</div>` : '';
            const courseLastChanged = course.lastChangedAt ?? '';

            return `
                <a class="course-card" href="${courseIndexPath}" data-course-last-changed-at="${courseLastChanged}">
                    <div class="course-image">${imageMarkup}</div>
                    <div class="course-body">
                        <h2>${course.courseName}</h2>
                        ${chipHtml}
                        <p class="course-meta">Updated ${updatedLabel}</p>
                        <div class="course-stats">
                            <span><strong>${course.modulesCount}</strong> modules</span>
                            <span><strong>${course.lessonsCount}</strong> lessons</span>
                        </div>
                    </div>
                </a>
            `;
        })
    );

    const indexHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${groupName} - Courses</title>
            <style>
                :root {
                    --bg: #f8f6f1;
                    --panel: #ffffff;
                    --panel-2: #f5f7fb;
                    --text: #16181f;
                    --muted: #5c6575;
                    --accent: #3b82f6;
                    --accent-2: #0f172a;
                    --ring: rgba(20,22,29,0.08);
                    --shadow: 0 18px 36px rgba(15, 23, 42, 0.12);
                }
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                    background: #f6f6f8;
                    color: var(--text);
                    line-height: 1.6;
                }
                .page {
                    max-width: 1100px;
                    margin: 48px auto 80px;
                    padding: 0 24px;
                }
                .hero {
                    background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.92) 100%);
                    border-radius: 26px;
                    padding: 32px;
                    box-shadow:
                        0 25px 45px rgba(15, 23, 42, 0.18),
                        0 10px 20px rgba(15, 23, 42, 0.08);
                }
                .hero-title {
                    font-size: clamp(2.3rem, 4vw, 3.2rem);
                    margin: 0 0 8px 0;
                    letter-spacing: -0.02em;
                }
                .hero-subtitle {
                    color: var(--muted);
                    margin: 0 0 18px 0;
                    font-size: 1.05rem;
                }
                .hero-meta {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                }
                .chip {
                    padding: 10px 14px;
                    border-radius: 999px;
                    background: var(--panel-2);
                    border: 1px solid var(--ring);
                    color: var(--text);
                    font-size: 0.95rem;
                }
                .chip strong { color: var(--accent); font-weight: 700; }
                .courses {
                    margin-top: 32px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 18px;
                }
                .course-card {
                    background: var(--panel);
                    border: 1px solid rgba(15, 23, 42, 0.05);
                    border-radius: 18px;
                    overflow: hidden;
                    text-decoration: none;
                    color: inherit;
                    display: flex;
                    flex-direction: column;
                    min-height: 100%;
                    transition: transform 0.25s ease, box-shadow 0.25s ease;
                    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
                }
                .course-card:hover {
                    transform: translateY(-6px);
                    box-shadow:
                        0 30px 60px rgba(15, 23, 42, 0.25),
                        0 14px 30px rgba(15, 23, 42, 0.15);
                }
                .course-image {
                    aspect-ratio: 16 / 9;
                    min-height: 0;
                    background: #f0f2f7;
                    border-bottom: 1px solid var(--ring);
                    overflow: hidden;
                }
                .course-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .course-fallback {
                    height: 100%;
                    display: grid;
                    place-items: center;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-body {
                    padding: 18px 18px 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .course-body h2 {
                    margin: 0;
                    font-size: 1.2rem;
                }
                .course-meta {
                    margin: 0;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    font-size: 0.95rem;
                }
                .course-stats strong { color: var(--accent-2); }
                .freshness-chips {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                }
                .freshness-chip {
                    font-size: 0.72rem;
                    padding: 3px 10px;
                    border-radius: 999px;
                    font-weight: 700;
                    letter-spacing: 0.04em;
                    display: inline-block;
                }
                .freshness-chip-new     { background: #dcfce7; color: #14532d; }
                .freshness-chip-updated { background: #fef3c7; color: #78350f; }
                .filter-bar {
                    margin: 24px 0 0 0;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .filter-bar select {
                    padding: 6px 10px;
                    border-radius: 8px;
                    border: 1px solid rgba(20,22,29,0.12);
                    background: white;
                }
            </style>
        </head>
        <body>
            <div class="page">
                <section class="hero">
                    <h1 class="hero-title">${groupName}</h1>
                    <p class="hero-subtitle">All downloaded courses for this community.</p>
                    <div class="hero-meta">
                        <div class="chip"><strong>${courses.length}</strong> courses</div>
                        <div class="chip"><strong>${totalLessons}</strong> lessons</div>
                        <div class="chip">Updated: <strong>${new Date().toLocaleDateString()}</strong></div>
                    </div>
                </section>
                <div class="filter-bar">
                    <label for="freshness-filter">Show:</label>
                    <select id="freshness-filter">
                        <option value="all">All</option>
                        <option value="24h">Last 24h</option>
                        <option value="7d">Last 7 days</option>
                        <option value="30d">Last 30 days</option>
                    </select>
                </div>
                <section class="courses">
                    ${courseCards.join('')}
                </section>
            </div>
            <script>
            (function() {
                var select = document.getElementById('freshness-filter');
                if (!select) return;
                var KEY = 'skool-group-freshness-filter';
                var saved = localStorage.getItem(KEY);
                if (saved) select.value = saved;
                function apply() {
                    var v = select.value;
                    localStorage.setItem(KEY, v);
                    var cutoff = null;
                    if (v === '24h') cutoff = Date.now() - 86400000;
                    else if (v === '7d') cutoff = Date.now() - 7*86400000;
                    else if (v === '30d') cutoff = Date.now() - 30*86400000;
                    var nodes = document.querySelectorAll('[data-course-last-changed-at]');
                    for (var i = 0; i < nodes.length; i++) {
                        var el = nodes[i];
                        if (cutoff == null) { el.style.display = ''; continue; }
                        var ts = Date.parse(el.getAttribute('data-course-last-changed-at') || '');
                        el.style.display = (!isNaN(ts) && ts >= cutoff) ? '' : 'none';
                    }
                }
                select.addEventListener('change', apply);
                apply();
            })();
            </script>
        </body>
        </html>
    `;

    await writeAtomicHtml(path.join(groupDir, 'index.html'), indexHtml);

    log('\nGroup index regenerated successfully.');
    log(`Saved to: ${path.join(groupDir, 'index.html')}`);
}

export { regenerateGroupIndex };
