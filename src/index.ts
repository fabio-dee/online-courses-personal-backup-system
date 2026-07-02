import { Scraper } from "./scraper.js";
import { Downloader } from "./downloader.js";
import { regenerateIndex } from "./regenerate-index.js";
import { regenerateGroupIndex } from "./regenerate-group-index.js";
import { createConsoleLogger, type Logger } from "./logger.js";
import {
	computeContentHash,
	videoFingerprintsEqual,
	computeFullFingerprint,
	type VideoFingerprint,
	type FullFingerprint,
} from "./fingerprint.js";
import { scoreVideo, scoreBody } from "./fingerprint/score.js";
import { escalatedScore } from "./fingerprint/perceptual/escalate.js";
import type { PerceptualFingerprint } from "./fingerprint/perceptual/types.js";
import {
	createRunStats,
	mergeRunIntoLog,
	stampFpSchema,
	printRunReport,
	type LessonChange,
	type LessonEventType,
	type LessonOutcome,
} from "./run-log.js";
import fs from "fs-extra";
import path from "path";
import pLimit from "p-limit";

/**
 * Thrown by the sanity-check when >30% of lessons have no prior manifest.
 * Caught by the CLI entry point AFTER scraper.close() runs via the finally block,
 * so Playwright is never leaked (P0-4 fix — replaces process.exit(2) inside try).
 */
export class SanityCheckAbort extends Error {
	readonly exitCode = 2;
	constructor(message: string) {
		super(message);
		this.name = "SanityCheckAbort";
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
			logger.error("⚠️ Failed to regenerate index during shutdown.", err);
		} finally {
			process.exit(0);
		}
	};

	process.once("SIGINT", () => {
		void handleShutdown("SIGINT");
	});
	process.once("SIGTERM", () => {
		void handleShutdown("SIGTERM");
	});
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

export type DownloadMode = "auto" | "course" | "lesson";

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
	/** When true: bypass the fp_schema=2 early-skip optimization in --refingerprint. */
	forceRefingerprint?: boolean;
	/**
	 * Optional explicit vault root for the global lessonId index walk. When the
	 * caller is iterating multiple courses in a classroom and outputDir already
	 * contains a groupName/courseName suffix, set vaultRoot to the user's `-o`
	 * value so the scan root reaches the actual vault top-level.
	 */
	vaultRoot?: string;
	/**
	 * When true, allow the layout-fork redirect (Skool's API returned a
	 * groupName/courseName that differs from the existing on-disk layout) to
	 * proceed. The redirect rebinds writes to the existing layout AND, after a
	 * successful run, removes the freshly-computed (now-orphan) fork dirs.
	 *
	 * Default false: refuse the run with a LayoutForkRefusedError so the user
	 * can reconcile the two layouts manually (the historical default silently
	 * forked, which produced 26 GB of duplicated content on a real run).
	 */
	allowLayoutFork?: boolean;
};

/**
 * Thrown when the downloader detects that Skool's API would write to a
 * different on-disk layout than where existing lessons already live, AND
 * `allowLayoutFork` is not set. The user must either pass --allow-layout-fork
 * (after backing up) or manually reconcile the two paths before re-running.
 */
export class LayoutForkRefusedError extends Error {
	constructor(
		public readonly existingPath: string,
		public readonly freshPath: string,
	) {
		super(
			`Vault layout fork detected and --allow-layout-fork was not set.\n` +
				`   existing lessons at: ${existingPath}\n` +
				`   new scrape would write to: ${freshPath}\n` +
				`\n` +
				`Refusing to proceed: writing to the new path while content exists at\n` +
				`the old path would silently duplicate the entire course on disk and\n` +
				`poison downstream tooling (transcripts, vault builder, MOCs).\n` +
				`\n` +
				`To resolve, choose ONE of:\n` +
				`  1. Manually move/merge "${freshPath}" into "${existingPath}" and re-run.\n` +
				`  2. Delete "${freshPath}" if it was created empty by an earlier aborted run.\n` +
				`  3. Re-run with --allow-layout-fork to redirect writes to the existing\n` +
				`     path and remove the orphan fork dirs after the run succeeds.\n`,
		);
		this.name = "LayoutForkRefusedError";
	}
}

/**
 * Thrown when the post-run orphan cleanup fails after a layout-fork redirect.
 * Promoted from the previous best-effort/non-fatal behavior so users learn
 * about leftover duplicate trees instead of silently accumulating them.
 */
export class LayoutForkCleanupError extends Error {
	constructor(
		public readonly orphanPath: string,
		public readonly cause: unknown,
	) {
		super(
			`Layout-fork orphan cleanup failed.\n` +
				`   could not remove: ${orphanPath}\n` +
				`   cause: ${String(cause)}\n` +
				`\n` +
				`The download itself completed successfully and content is at the\n` +
				`canonical existing layout. Remove the orphan path manually:\n` +
				`   rm -rf "${orphanPath}"\n`,
		);
		this.name = "LayoutForkCleanupError";
	}
}

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
async function writeFingerprintSidecar(
	lessonDir: string,
	fp: FullFingerprint,
): Promise<void> {
	await writeAtomicJson(path.join(lessonDir, "lesson.fingerprint.json"), fp);
}

/**
 * Read the sidecar fingerprint for a lesson dir, preferring sidecar over in-manifest copy.
 * Returns null if neither exists or sidecar is unparseable.
 */
/**
 * P1-3: Validate that a parsed sidecar object has the required top-level keys
 * before trusting it. Returns true only when all four required fields are present
 * with acceptable types (object|null for ffprobe/chunks, string|null for bodyHash/playbackId).
 */
function isFingerprintShapeValid(data: Record<string, unknown>): boolean {
	// ffprobe: object or null
	if (
		!("ffprobe" in data) ||
		(data["ffprobe"] !== null && typeof data["ffprobe"] !== "object")
	)
		return false;
	// chunks: object or null
	if (
		!("chunks" in data) ||
		(data["chunks"] !== null && typeof data["chunks"] !== "object")
	)
		return false;
	// bodyHash: string or null
	if (
		!("bodyHash" in data) ||
		(data["bodyHash"] !== null && typeof data["bodyHash"] !== "string")
	)
		return false;
	// playbackId: string or null
	if (
		!("playbackId" in data) ||
		(data["playbackId"] !== null && typeof data["playbackId"] !== "string")
	)
		return false;
	return true;
}

async function readFingerprintSidecar(
	lessonDir: string,
	logger?: Logger,
): Promise<FullFingerprint | null> {
	const sidecarPath = path.join(lessonDir, "lesson.fingerprint.json");
	if (!fs.existsSync(sidecarPath)) return null;
	try {
		const data = (await fs.readJson(sidecarPath)) as unknown;
		if (
			typeof data === "object" &&
			data !== null &&
			(data as { fp_schema?: unknown }).fp_schema === 2
		) {
			// P1-3: Guard against truncated sidecars that pass fp_schema check but
			// are missing required keys — they crash later in scoreVideo/scoreBody.
			const rec = data as Record<string, unknown>;
			if (!isFingerprintShapeValid(rec)) {
				logger?.warn(
					`    ⚠️  Sidecar at ${sidecarPath} is missing required keys — treating as absent`,
				);
				return null;
			}
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
	const videoPath = path.join(lessonDir, "video.mp4");
	const hevcPath = path.join(lessonDir, "video.hevc.mp4");
	const existingVideoPath = [videoPath, hevcPath].find(
		(p) => fs.existsSync(p) && fs.statSync(p).size > 0,
	);
	if (!existingVideoPath) {
		return { fp: null, wasStale: true };
	}

	// bodyHash MUST be null in offline rebuild paths.
	// index.html on disk is the rendered offline-viewer template (custom HTML
	// wrapping with nav, theming, asset rewrites) — NOT the raw lesson body
	// that the live --update path hashes from lessonData.contentHtml. Hashing
	// the template would create permanent mismatches → false text-updated on
	// every run. scoreBody treats null on either side as UNCHANGED (Wave A
	// P0-1 fix). Legacy contentHash on lesson.json still catches real body
	// changes via the live --update path which sets bodyHash correctly.
	try {
		const fp = await computeFullFingerprint(
			existingVideoPath,
			null,
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
 *
 * When forceRefingerprint is false (default), skips lessons that already have:
 * 1. lesson.json with fullFingerprint.fp_schema === 2
 * 2. lesson.fingerprint.json sidecar with fp_schema === 2
 * 3. Video mtime older than sidecar mtime (video hasn't been re-encoded)
 */
async function runRefingerprint(
	outputDir: string,
	logger: Logger,
	forceRefingerprint = false,
): Promise<void> {
	logger.info(
		"🔬 --refingerprint: scanning vault for lessons to re-fingerprint...",
	);
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
			const manifestPath = path.join(subDir, "lesson.json");
			if (fs.existsSync(manifestPath)) {
				// This is a lesson dir
				try {
					const manifest = (await fs.readJson(manifestPath)) as LessonManifest;
					if (!manifest.lessonId) continue;

					// Resolve the group root once per lesson so we stamp it
					// even if the lesson is later skipped (already current,
					// no video, etc.) — otherwise an all-skipped run leaves
					// the group log unstamped.
					let groupRoot = outputDir;
					let probeForGroup = path.dirname(subDir);
					while (
						probeForGroup.startsWith(outputDir) &&
						probeForGroup !== outputDir
					) {
						const candidate = path.join(probeForGroup, ".group-log.json");
						if (fs.existsSync(candidate)) {
							try {
								const log = (await fs.readJson(candidate)) as {
									lessons?: Record<string, unknown>;
								};
								if (log.lessons && Object.keys(log.lessons).length > 0) {
									groupRoot = probeForGroup;
									break;
								}
							} catch {
								// Corrupt log — keep walking
							}
						}
						probeForGroup = path.dirname(probeForGroup);
					}
					touchedGroupDirs.add(groupRoot);

					const videoPath = path.join(subDir, "video.mp4");
					const hevcPath = path.join(subDir, "video.hevc.mp4");
					const existingVideoPath = [videoPath, hevcPath].find(
						(p) => fs.existsSync(p) && fs.statSync(p).size > 0,
					);
					if (!existingVideoPath) {
						skipped += 1;
						continue;
					}

					// P2-1: Early skip if lesson is already at fp_schema=2 and video hasn't changed
					if (!forceRefingerprint) {
						const sidecarPath = path.join(subDir, "lesson.fingerprint.json");
						const hasSidecar = fs.existsSync(sidecarPath);
						const hasManifestFp = manifest.fullFingerprint?.fp_schema === 2;
						if (hasSidecar && hasManifestFp) {
							try {
								const sidecar = (await fs.readJson(sidecarPath)) as {
									fp_schema?: number;
								};
								if (sidecar.fp_schema === 2) {
									const videoMtime = fs.statSync(existingVideoPath).mtimeMs;
									const sidecarMtime = fs.statSync(sidecarPath).mtimeMs;
									if (videoMtime < sidecarMtime) {
										// Video is older than sidecar → no re-encoding since last fingerprint
										const relPath = path.relative(outputDir, subDir);
										logger.info(
											`⏭️  Skipped (already at fp_schema=2): ${relPath}`,
										);
										skipped += 1;
										continue;
									}
								}
							} catch {
								// Fall through to recompute if sidecar is corrupted
							}
						}
					}

					// bodyHash MUST be null here — index.html on disk is the
					// rendered offline-viewer template, not the raw lesson body
					// that --update hashes. See loadOrRebuildFingerprint above.
					const fp = await computeFullFingerprint(
						existingVideoPath,
						null,
						manifest.videoFingerprint?.playbackId,
					);
					const updatedManifest: LessonManifest = {
						...manifest,
						fullFingerprint: fp,
					};
					await writeAtomicJson(manifestPath, updatedManifest);
					await writeFingerprintSidecar(subDir, fp);
					rebuilt += 1;
					// Group dir already added to touchedGroupDirs above.
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
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
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
			logger.warn(
				`  ⚠️ Failed to stamp group log at ${groupDir}: ${String(err)}`,
			);
		}
	}

	logger.info(
		`🔬 --refingerprint complete: ${rebuilt} rebuilt, ${skipped} skipped (no video).`,
	);
}

function getUrlExtension(url: string) {
	try {
		const ext = path.extname(new URL(url).pathname);
		if (ext && ext.length <= 5) return ext;
	} catch (err) {
		// Ignore parsing errors, fallback below.
	}
	return ".jpg";
}

function sanitizeName(value: string) {
	return value.replace(/[/\\?%*:|"<>]/g, "-");
}

function resolveTargetLessonId(
	url: string,
	mode: DownloadMode,
	explicitLessonId?: string | null,
) {
	if (mode === "course") return null;

	let targetLessonId = explicitLessonId ?? null;
	try {
		const urlObj = new URL(url);
		if (!targetLessonId) {
			targetLessonId =
				urlObj.searchParams.get("md") || urlObj.searchParams.get("lesson");
		}
	} catch (err) {
		// Ignore parsing errors, caller will validate.
	}

	if (mode === "lesson" && !targetLessonId) {
		throw new Error(
			"Lesson mode requires a lesson id in the URL or explicit lessonId option.",
		);
	}

	return targetLessonId;
}

function normalizeConcurrency(value: number | undefined) {
	if (!Number.isFinite(value) || value === undefined)
		return DEFAULT_CONCURRENCY;
	const floored = Math.floor(value);
	if (floored <= 0) return DEFAULT_CONCURRENCY;
	return Math.min(MAX_CONCURRENCY, floored);
}

async function runConcurrent(
	tasks: Array<() => Promise<void>>,
	concurrency: number,
) {
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
			if (current >= tasks.length) return undefined;
			await tasks[current]();
		}
	});

	await Promise.all(workers);
}

export async function downloadCourse(
	options: DownloadOptions,
): Promise<DownloadSummary> {
	const logger = options.logger ?? createConsoleLogger();

	// --refingerprint: rebuild all fingerprints from disk, no network needed.
	if (options.refingerprint) {
		const outputDir = options.outputDir
			? options.outputDir
			: path.join(process.cwd(), "downloads");
		await runRefingerprint(outputDir, logger, options.forceRefingerprint);
		// Return a minimal summary — caller doesn't use it in this mode.
		return {
			courseName: "",
			groupName: "",
			outputDir,
			modulesCount: 0,
			lessonsCount: 0,
			completedLessons: 0,
			failedLessons: 0,
			targetLessonId: null,
		};
	}

	const concurrency = normalizeConcurrency(options.concurrency);
	const mode = options.mode ?? "auto";
	const inputUrl = options.url.replace(/\\/g, "");

	let classroomUrl = inputUrl;
	try {
		classroomUrl = new URL(inputUrl).toString();
	} catch (err) {
		throw new Error(`Invalid URL: ${inputUrl}`);
	}

	const targetLessonId = resolveTargetLessonId(
		classroomUrl,
		mode,
		options.lessonId,
	);
	classroomUrl = classroomUrl.split("?")[0];

	const scraper = new Scraper(logger);
	const downloader = new Downloader(logger);

	let completedLessons = 0;
	let failedLessons = 0;

	const stats = createRunStats({
		courseName: "",
		groupName: "",
		mode,
		update: options.update === true,
	});

	try {
		logger.info("🚀 Fetching course structure...");
		let { modules, courseName, groupName, courseImageUrl } =
			await scraper.parseClassroom(classroomUrl);
		stats.courseName = courseName;
		stats.groupName = groupName;

		if (modules.length === 0) {
			throw new Error(
				"No modules found. Are you sure this is a classroom URL and you are logged in?",
			);
		}

		if (targetLessonId) {
			logger.info(`📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
			let found = false;
			for (const module of modules) {
				const lesson = module.lessons.find((l) => l.id === targetLessonId);
				if (lesson) {
					module.lessons = [lesson];
					modules = [module];
					found = true;
					break;
				}
			}

			if (!found) {
				throw new Error(
					`Could not find lesson with ID ${targetLessonId} in this classroom.`,
				);
			}

			logger.info(`✅ Found lesson: ${modules[0].lessons[0].title}`);
		} else {
			logger.info(`✅ Found ${modules.length} modules.`);
		}

		const sanitizedGroupName = sanitizeName(groupName);
		const sanitizedCourseName = sanitizeName(courseName);

		const defaultOutputDir = path.join(
			process.cwd(),
			"downloads",
			sanitizedGroupName,
			sanitizedCourseName,
		);

		const outputOverride = options.outputDir || undefined;
		// baseOutputDir is `let` so the layout-fork redirect (Phase 6) can rebind
		// it to the existing-lesson parent BEFORE any course-level writes happen.
		let baseOutputDir = outputOverride || defaultOutputDir;
		if (!baseOutputDir) {
			throw new Error("Output directory resolution failed.");
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
		}> = modules.map((m) => ({
			title: m.title,
			lessons: [] as any[],
			totalLessons: m.lessons.length,
			mIndex: m.index,
			moduleDirName: m.root ? "" : `${m.index}-${sanitizeName(m.title)}`,
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
			const lessonOutputDir = path.join(
				baseOutputDir,
				moduleInfo.moduleDirName,
				lessonDirName,
			);
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
					: `${lessonDirName}/index.html`,
			};
		}

		const totalLessons = modules.reduce(
			(sum, module) => sum + module.lessons.length,
			0,
		);
		options.callbacks?.onCourseStart?.({
			courseName,
			groupName,
			modulesCount: modules.length,
			lessonsCount: totalLessons,
			outputDir: baseOutputDir,
			targetLessonId,
			lessonDestination,
		});

		// Course cover image and .course.json writes are deferred until AFTER
		// the layout-fork detection so they land at the canonical (possibly
		// redirected) baseOutputDir, not the fresh fork tree.
		let courseImagePath: string | undefined;

		const courseManifest: CourseManifest = {
			courseName,
			groupName,
			courseImageUrl,
			courseImagePath,
			modules: courseInfo.map((m) => ({
				index: m.mIndex,
				title: m.title,
				moduleDirName: m.moduleDirName,
				root: modules.find((mod) => mod.index === m.mIndex)?.root,
			})),
			updatedAt: new Date().toISOString(),
		};

		// .course.json write is deferred until AFTER the layout-fork detection
		// below, so that on a fork it lands in the EXISTING course dir, not the
		// freshly-computed one (which would orphan a duplicate manifest).

		// ---------------------------------------------------------------------------
		// Fix 1 — Global lessonId index.
		// Walk the entire outputDir tree ONCE, building a map of lessonId →
		// absolute lesson directory. This lets us find existing lesson dirs that
		// live under a different parent (e.g. a previous run wrote under a
		// different groupName slug) — the vault-relocation bug.
		//
		// Hard-capped at 10 levels deep to avoid pathological recursion.
		// When a lessonId appears at multiple paths, prefer the one with the most
		// recent lastCheckedAt and log a duplicate warning.
		// ---------------------------------------------------------------------------
		/** Global map: lessonId → absolute path of the lesson directory. */
		const globalLessonIdIndex = new Map<string, string>();

		async function buildGlobalLessonIdIndex(
			dir: string,
			depth = 0,
		): Promise<void> {
			if (depth > 10) return;
			let entries: fs.Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			await Promise.all(
				entries.map(async (entry) => {
					if (!entry.isDirectory()) return undefined;
					const subDir = path.join(dir, entry.name);
					const manifestPath = path.join(subDir, "lesson.json");
					if (fs.existsSync(manifestPath)) {
						try {
							const manifest = (await fs.readJson(manifestPath)) as {
								lessonId?: string;
								lastCheckedAt?: string;
							};
							if (manifest.lessonId) {
								const existing = globalLessonIdIndex.get(manifest.lessonId);
								if (existing) {
									// Duplicate lessonId in vault — prefer most recently checked.
									let existingCheckedAt = 0;
									try {
										const em = (await fs.readJson(
											path.join(existing, "lesson.json"),
										)) as { lastCheckedAt?: string };
										existingCheckedAt = em.lastCheckedAt
											? new Date(em.lastCheckedAt).getTime()
											: 0;
									} catch {
										/* keep 0 */
									}
									const newCheckedAt = manifest.lastCheckedAt
										? new Date(manifest.lastCheckedAt).getTime()
										: 0;
									if (newCheckedAt > existingCheckedAt) {
										globalLessonIdIndex.set(manifest.lessonId, subDir);
									}
									process.stderr.write(
										`⚠️  Duplicate vault copies for lessonId ${manifest.lessonId}:\n` +
											`   ${existing}\n   ${subDir}\n` +
											`   Keeping the more recently checked copy.\n`,
									);
								} else {
									globalLessonIdIndex.set(manifest.lessonId, subDir);
								}
							}
						} catch {
							// Unreadable manifest — skip
						}
					} else {
						// Not a lesson dir; recurse.
						await buildGlobalLessonIdIndex(subDir, depth + 1);
					}
				}),
			);
		}

		// Scan root: prefer the explicit vaultRoot when the CLI passes it (classroom
		// iteration sets outputDir to <vaultRoot>/<groupName>/<courseName>, so dirname
		// of outputDir would only see the groupName tree and miss legacy flat layouts).
		// Fall back to the user-supplied outputOverride's dirname, then to the computed
		// default. The 10-level depth cap in buildGlobalLessonIdIndex keeps this bounded.
		const scanRoot = options.vaultRoot
			? options.vaultRoot
			: outputOverride
				? path.dirname(outputOverride)
				: path.dirname(path.dirname(baseOutputDir));
		logger.info("🔍 Scanning vault for existing lessons...");
		await buildGlobalLessonIdIndex(scanRoot);
		logger.info(
			`   Found ${globalLessonIdIndex.size} existing lessons in vault.`,
		);

		// ---------------------------------------------------------------------------
		// Fix 3 — Layout-fork warning.
		// Detect when the freshly computed scrape path diverges from where the
		// global index says a lesson already lives, and warn BEFORE downloading.
		// ---------------------------------------------------------------------------
		// Track orphan paths produced by a layout-fork redirect so the post-run
		// cleanup (gated on full run success) can FATALLY remove them. Promoted
		// from the previous in-block best-effort cleanup, which silently failed
		// and left 26 GB of duplicated content on a real production run.
		let layoutForkOrphanCourseDir: string | null = null;
		let layoutForkOrphanGroupDir: string | null = null;
		{
			// Sample up to 5 lessonIds from the scrape to find any that already
			// exist in the vault but outside the current baseOutputDir tree.
			const sampleLessons = modules.flatMap((m) => m.lessons).slice(0, 5);
			let forkExistingParent: string | null = null;
			for (const sample of sampleLessons) {
				const existing = globalLessonIdIndex.get(sample.id);
				// A fork exists when the lesson is known globally but lives OUTSIDE
				// the fresh course output dir (baseOutputDir already incorporates any
				// user-supplied -o override; no groupName/courseName appended here).
				if (
					existing &&
					!existing.startsWith(baseOutputDir + path.sep) &&
					existing !== baseOutputDir
				) {
					// Report the course-level ancestor of the existing lesson dir.
					forkExistingParent = path.dirname(path.dirname(existing)); // lesson→module→course
					break;
				}
			}
			if (forkExistingParent) {
				// REFUSE-BY-DEFAULT (Phase 1 fix). Historically this branch
				// silently redirected and best-effort cleaned up the orphan
				// tree. The cleanup failed silently in production, leaving
				// a 26 GB duplicate vault on disk that poisoned downstream
				// tooling. Now: refuse unless the user explicitly opted in
				// via --allow-layout-fork.
				if (!options.allowLayoutFork) {
					throw new LayoutForkRefusedError(forkExistingParent, baseOutputDir);
				}

				process.stderr.write(
					`\n⚠️  vault layout fork detected (--allow-layout-fork active)\n` +
						`   existing lessons at: ${forkExistingParent}\n` +
						`   new scrape would write to: ${baseOutputDir}\n` +
						`   reusing existing locations; orphan path will be removed\n` +
						`   AFTER successful run completion (failure to remove is fatal).\n\n`,
				);

				// Redirect bookkeeping writes (.course.json, regenerateIndex,
				// regenerateGroupIndex, mergeRunIntoLog) to the existing layout.
				// Otherwise the freshly-computed groupName/courseName tree gets
				// populated with course-level metadata + a parallel .group-log.json
				// even though the lesson content correctly stays in the legacy paths.
				const previousBase = baseOutputDir;
				baseOutputDir = forkExistingParent;
				activeOutputDir = baseOutputDir;
				activeGroupDir = path.dirname(baseOutputDir);

				// Defer cleanup to the post-run phase. We MUST NOT delete
				// anything mid-run: if the scrape fails partway, the user
				// needs both layouts intact to diagnose. Remember the orphan
				// path; the cleanup phase below will verify run success,
				// re-check the orphan is empty of lesson content, and
				// remove it (fatal on failure).
				layoutForkOrphanCourseDir = previousBase;
				const previousGroup = path.dirname(previousBase);
				// Only mark the group dir for cleanup if it differs from the
				// existing layout's group dir (otherwise we'd nuke the parent
				// of our redirected target).
				if (
					previousGroup !== activeGroupDir &&
					previousGroup !== path.dirname(activeGroupDir ?? "")
				) {
					layoutForkOrphanGroupDir = previousGroup;
				}
			}
		}

		// Cover image and .course.json must be written AFTER the layout-fork
		// redirect above, so they land at the canonical existing course dir.
		if (courseImageUrl) {
			try {
				const assetsDir = path.join(baseOutputDir, "assets");
				await fs.ensureDir(assetsDir);
				const ext = getUrlExtension(courseImageUrl);
				const localName = `course-cover${ext}`;
				const localPath = path.join(assetsDir, localName);
				await downloader.downloadAsset(courseImageUrl, localPath);
				courseImagePath = `assets/${localName}`;
				courseManifest.courseImagePath = courseImagePath;
			} catch {
				logger.warn(
					"⚠️ Failed to download course image, continuing without it.",
				);
			}
		}

		// ---------------------------------------------------------------------------
		// Module layout reconciliation (update mode).
		// When Skool renames/reorders whole modules (for example adding
		// "(Archived)" and changing the numeric prefix), global lessonId lookup keeps
		// lesson updates safe, but without a filesystem move the vault retains stale
		// module folders and target folders contain only generated MOCs. Reconcile
		// whole-module moves before per-module scans so later processing writes to the
		// canonical current Skool path.
		// ---------------------------------------------------------------------------
		function samePath(a: string, b: string): boolean {
			return path.resolve(a) === path.resolve(b);
		}

		function isWithin(parent: string, child: string): boolean {
			const rel = path.relative(path.resolve(parent), path.resolve(child));
			return (
				rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
			);
		}

		async function countDirectLessonManifests(
			moduleDir: string,
		): Promise<number> {
			let entries: string[];
			try {
				entries = await fs.readdir(moduleDir);
			} catch {
				return 0;
			}
			let count = 0;
			for (const entry of entries) {
				const manifestPath = path.join(moduleDir, entry, "lesson.json");
				if (fs.existsSync(manifestPath)) count += 1;
			}
			return count;
		}

		async function containsLessonManifest(dir: string): Promise<boolean> {
			let entries: fs.Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return false;
			}
			for (const entry of entries) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (await containsLessonManifest(p)) return true;
				} else if (entry.isFile() && entry.name === "lesson.json") {
					return true;
				}
			}
			return false;
		}

		async function isPlaceholderOnlyModuleDir(dir: string): Promise<boolean> {
			if (!fs.existsSync(dir)) return true;
			if (await containsLessonManifest(dir)) return false;
			let entries: fs.Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return false;
			}
			for (const entry of entries) {
				const p = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					const childEntries = await fs.readdir(p).catch(() => [] as string[]);
					if (childEntries.length > 0) return false;
					continue;
				}
				if (!entry.isFile()) return false;
				const allowedGeneratedMoc =
					entry.name.startsWith("_") && entry.name.endsWith(".md");
				if (!allowedGeneratedMoc && entry.name !== ".DS_Store") return false;
			}
			return true;
		}

		async function reconcileModuleLayoutMoves(): Promise<void> {
			if (!options.update) return;

			const expectedModuleByLessonId = new Map<string, string>();
			for (let i = 0; i < modules.length; i++) {
				const mInfo = courseInfo[i];
				if (!mInfo.moduleDirName) continue;
				const expectedModuleDir = path.join(baseOutputDir, mInfo.moduleDirName);
				for (const lesson of modules[i].lessons) {
					expectedModuleByLessonId.set(lesson.id, expectedModuleDir);
				}
			}

			const sourceToTargets = new Map<string, Map<string, number>>();
			for (const [
				lessonId,
				existingLessonDir,
			] of globalLessonIdIndex.entries()) {
				const expectedModuleDir = expectedModuleByLessonId.get(lessonId);
				if (!expectedModuleDir) continue;
				const sourceModuleDir = path.dirname(existingLessonDir);
				if (samePath(sourceModuleDir, expectedModuleDir)) continue;
				// Only auto-move modules inside the current canonical course dir.
				// Cross-course/group moves are handled by layout-fork redirection or
				// left for manual review.
				if (!samePath(path.dirname(sourceModuleDir), baseOutputDir)) continue;
				if (!isWithin(baseOutputDir, expectedModuleDir)) continue;

				const targetCounts =
					sourceToTargets.get(sourceModuleDir) ?? new Map<string, number>();
				targetCounts.set(
					expectedModuleDir,
					(targetCounts.get(expectedModuleDir) ?? 0) + 1,
				);
				sourceToTargets.set(sourceModuleDir, targetCounts);
			}

			if (sourceToTargets.size === 0) return;

			const plannedTargets = new Set<string>();
			for (const [sourceModuleDir, targetCounts] of sourceToTargets.entries()) {
				const sourceLessonCount =
					await countDirectLessonManifests(sourceModuleDir);
				const sortedTargets = [...targetCounts.entries()].sort(
					(a, b) => b[1] - a[1],
				);
				const [targetModuleDir, movedLessonCount] = sortedTargets[0] ?? [];

				if (
					!targetModuleDir ||
					targetCounts.size !== 1 ||
					movedLessonCount !== sourceLessonCount
				) {
					const detail = [...targetCounts.entries()]
						.map(
							([target, count]) =>
								`${path.relative(baseOutputDir, sourceModuleDir)} -> ${path.relative(baseOutputDir, target)} (${count}/${sourceLessonCount})`,
						)
						.join("; ");
					throw new Error(
						`Refusing automatic module layout reconciliation because moved lessons do not form a whole-module rename: ${detail}`,
					);
				}

				if (plannedTargets.has(targetModuleDir)) {
					throw new Error(
						`Refusing automatic module layout reconciliation because multiple source modules target ${path.relative(baseOutputDir, targetModuleDir)}`,
					);
				}
				plannedTargets.add(targetModuleDir);

				const targetPlaceholderOnly =
					await isPlaceholderOnlyModuleDir(targetModuleDir);
				if (!targetPlaceholderOnly) {
					throw new Error(
						`Refusing to move ${path.relative(baseOutputDir, sourceModuleDir)} to ${path.relative(baseOutputDir, targetModuleDir)} because target contains lesson/content files`,
					);
				}
			}

			for (const [sourceModuleDir, targetCounts] of sourceToTargets.entries()) {
				const targetModuleDir = [...targetCounts.keys()][0];
				logger.info(
					`    🔀 Moving module layout: ${path.relative(baseOutputDir, sourceModuleDir)} → ${path.relative(baseOutputDir, targetModuleDir)}`,
				);
				if (fs.existsSync(targetModuleDir)) {
					await fs.remove(targetModuleDir);
				}
				await fs.ensureDir(path.dirname(targetModuleDir));
				await fs.move(sourceModuleDir, targetModuleDir, { overwrite: false });

				for (const [
					lessonId,
					existingLessonDir,
				] of globalLessonIdIndex.entries()) {
					if (isWithin(sourceModuleDir, existingLessonDir)) {
						const rel = path.relative(sourceModuleDir, existingLessonDir);
						globalLessonIdIndex.set(lessonId, path.join(targetModuleDir, rel));
					}
				}
			}
		}

		await reconcileModuleLayoutMoves();

		await writeAtomicJson(
			path.join(baseOutputDir, ".course.json"),
			courseManifest,
		);

		// ---------------------------------------------------------------------------
		// Pass 0: Build per-module lessonId→dirName maps (filesystem scan, no network).
		// This allows us to find existing lesson dirs even when Skool reorders lessons.
		// ---------------------------------------------------------------------------
		/** Returns a map of lessonId → existing subdirectory name within moduleDir. */
		async function buildLessonIdMap(
			moduleDir: string,
		): Promise<Map<string, string>> {
			const map = new Map<string, string>();
			let entries: string[];
			try {
				entries = await fs.readdir(moduleDir);
			} catch {
				return map;
			}
			await Promise.all(
				entries.map(async (entry) => {
					const manifestPath = path.join(moduleDir, entry, "lesson.json");
					try {
						if (!fs.existsSync(manifestPath)) return undefined;
						const manifest = (await fs.readJson(manifestPath)) as {
							lessonId?: string;
						};
						if (manifest.lessonId) {
							map.set(manifest.lessonId, entry);
						}
					} catch {
						// Ignore unreadable manifests
					}
				}),
			);
			return map;
		}

		// ---------------------------------------------------------------------------
		// Pass 1: Classify every lesson (new vs existing) purely from the filesystem.
		// Used for the sanity-check abort before any network downloads happen.
		// Fix 1: global map is checked FIRST; per-module map is the fallback.
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
			const moduleDir = mInfo.moduleDirName
				? path.join(baseOutputDir, mInfo.moduleDirName)
				: baseOutputDir;

			const idMap = await buildLessonIdMap(moduleDir);
			moduleLessonIdMaps.set(i, idMap);

			for (const lesson of module.lessons) {
				const lIndex = lesson.index ?? 1;
				const constructedDirName = `${lIndex}-${sanitizeName(lesson.title)}`;
				// Fix 1: global index first, then per-module map, then constructed name.
				const globalHit = globalLessonIdIndex.get(lesson.id);
				const resolvedDirName = globalHit
					? path.basename(globalHit)
					: (idMap.get(lesson.id) ?? constructedDirName);
				// isNew: false when global map has a hit (lesson exists somewhere in vault).
				const isNew = globalHit
					? false
					: !fs.existsSync(
							path.join(moduleDir, resolvedDirName, "lesson.json"),
						);
				allClassifications.push({
					lessonId: lesson.id,
					title: lesson.title,
					moduleTitle: mInfo.title,
					resolvedDirName,
					isNew,
				});
			}
		}

		// ---------------------------------------------------------------------------
		// Sanity-check abort (update mode only, skipped with --force-update).
		// Fix 2: totalPrior is the size of the global lessonId index (not the
		// per-course-path count) so the abort fires on vault-relocation scenarios
		// where the fresh course path is empty but the vault is full of lessons.
		// ---------------------------------------------------------------------------
		if (options.update && !options.forceUpdate) {
			// Fix 2: use global vault lesson count as the "prior" baseline.
			const totalPrior =
				globalLessonIdIndex.size > 0
					? globalLessonIdIndex.size
					: allClassifications.filter((c) => !c.isNew).length;
			const videosNew = allClassifications.filter((c) => c.isNew).length;
			const ratio = videosNew / Math.max(totalPrior, 1);

			if (totalPrior >= 20 && ratio > 0.3) {
				const ts = new Date().toISOString().replace(/[:.]/g, "-");
				const abortFile = path.join(
					baseOutputDir,
					`.update-aborted-${ts}.json`,
				);

				const flagged = allClassifications
					.filter((c) => c.isNew)
					.map((c) => ({
						lessonId: c.lessonId,
						title: c.title,
						moduleTitle: c.moduleTitle,
						reason: "no-prior-manifest",
					}));

				const report = {
					abortedAt: new Date().toISOString(),
					courseName,
					baseOutputDir,
					totalPrior,
					videosNew,
					ratio: Math.round(ratio * 1000) / 1000,
					flagged,
				};

				try {
					await writeAtomicJson(abortFile, report);
				} catch {
					// Best-effort; don't mask the real error.
				}

				// Print table to stderr.
				process.stderr.write(
					`\n⛔  Sanity-check abort — ${videosNew} of ${totalPrior + videosNew} lessons have no prior manifest (${Math.round(ratio * 100)}% > 30%).\n`,
				);
				process.stderr.write(
					`    This usually means lesson directories were renamed due to upstream reordering.\n`,
				);
				process.stderr.write(
					`    Re-run with --force-update to bypass, or check the report: ${abortFile}\n\n`,
				);
				process.stderr.write(`    Flagged lessons (first 20):\n`);
				process.stderr.write(
					`    ${"lessonId".padEnd(36)} ${"module".padEnd(30)} title\n`,
				);
				process.stderr.write(
					`    ${"-".repeat(36)} ${"-".repeat(30)} ${"-".repeat(40)}\n`,
				);
				for (const f of flagged.slice(0, 20)) {
					process.stderr.write(
						`    ${f.lessonId.padEnd(36)} ${f.moduleTitle.slice(0, 30).padEnd(30)} ${f.title.slice(0, 60)}\n`,
					);
				}
				if (flagged.length > 20) {
					process.stderr.write(
						`    ... and ${flagged.length - 20} more (see ${abortFile})\n`,
					);
				}
				process.stderr.write("\n");

				// Throw instead of process.exit(2) so the finally block runs
				// scraper.close() before Node exits (P0-4: prevents Playwright leak).
				throw new SanityCheckAbort(
					`Sanity-check abort — ${videosNew} of ${totalPrior + videosNew} lessons have no prior manifest`,
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
			const moduleDir = mInfo.moduleDirName
				? path.join(baseOutputDir, mInfo.moduleDirName)
				: baseOutputDir;
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
						// Fix 1: global index first → per-module map → constructed name.
						// When global map has a hit, use that ABSOLUTE path directly so
						// the lesson is downloaded to / fingerprinted at its existing
						// location rather than the freshly-computed path under baseOutputDir.
						const globalLessonDir = globalLessonIdIndex.get(lesson.id);
						const lessonDirName = globalLessonDir
							? path.basename(globalLessonDir)
							: (idMap.get(lesson.id) ?? constructedDirName);
						const lessonDir =
							globalLessonDir ?? path.join(moduleDir, lessonDirName);

						options.callbacks?.onLessonStart?.({
							moduleIndex: mInfo.mIndex,
							lessonIndex: lIndex,
							lessonTitle: lesson.title,
						});

						logger.info(
							`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`,
						);

						try {
							updateStatus("Loading lesson data...");
							await fs.ensureDir(lessonDir);
							const lessonData = await scraper.extractLessonData(lesson.url);

							const manifestPath = path.join(lessonDir, "lesson.json");
							let oldManifest: LessonManifest | null = null;
							if (fs.existsSync(manifestPath)) {
								try {
									oldManifest = (await fs.readJson(
										manifestPath,
									)) as LessonManifest;
								} catch {
									oldManifest = null;
								}
							}

							const newContentHash = computeContentHash(lessonData);
							const isNewLesson = oldManifest == null;
							// textChanged starts as legacy hash comparison; may be upgraded by scoreBody below.
							let textChanged =
								!isNewLesson && oldManifest?.contentHash !== newContentHash;

							stats.textsChecked += 1;
							if (lessonData.videoLink) {
								stats.videosChecked += 1;
							}

							updateStatus("Localizing images...");
							const localizedHtml = await downloader.localizeImages(
								lessonData.contentHtml || "",
								lessonDir,
							);

							let hasVideo = false;
							let videoChanged = false;
							let videoWasNewlyDownloaded = false;
							let videoFingerprint: VideoFingerprint | undefined =
								oldManifest?.videoFingerprint;
							// Tracks the freshest FullFingerprint computed during this lesson run.
							// Hoisted here so the manifest-write below can always use the latest value
							// rather than the stale oldManifest.fullFingerprint (P0-2 fix).
							let lastComputedFullFp: FullFingerprint | null = null;
							if (lessonData.videoLink) {
								const videoPath = path.join(lessonDir, "video.mp4");
								const hevcPath = path.join(lessonDir, "video.hevc.mp4");
								// Accept either the original download OR the post-encoded HEVC variant as "present".
								const videoExistsBefore = [videoPath, hevcPath].some(
									(p) => fs.existsSync(p) && fs.statSync(p).size > 0,
								);

								if (options.update && videoExistsBefore) {
									updateStatus("Checking video freshness...");
									const newFp = await downloader.getVideoFingerprint(
										lessonData.videoLink,
									);
									if (newFp && lessonData.muxPlaybackId && !newFp.playbackId) {
										newFp.playbackId = lessonData.muxPlaybackId;
									}

									const localVideoPath =
										[videoPath, hevcPath].find(
											(p) => fs.existsSync(p) && fs.statSync(p).size > 0,
										) ?? videoPath;

									const hasBaseline = oldManifest?.videoFingerprint != null;

									if (!hasBaseline) {
										// First --update run: record fingerprint, trust local file.
										logger.info(
											`    📝 Recording video fingerprint (first --update, trusting local file)`,
										);
										hasVideo = true;
										videoFingerprint = newFp ?? undefined;
										// Compute and store full fingerprint for future runs.
										try {
											const fullFp = await computeFullFingerprint(
												localVideoPath,
												lessonData.contentHtml ?? "",
												newFp?.playbackId ?? lessonData.muxPlaybackId,
											);
											lastComputedFullFp = fullFp;
											videoFingerprint = newFp ?? undefined;
											const updatedManifest = oldManifest
												? { ...oldManifest, fullFingerprint: fullFp }
												: null;
											if (updatedManifest) {
												await writeAtomicJson(
													path.join(lessonDir, "lesson.json"),
													updatedManifest,
												);
											}
											await writeFingerprintSidecar(lessonDir, fullFp);
										} catch {
											// Non-fatal: legacy path still works
										}
									} else {
										// Defense-in-depth: use full scoring engine when available.
										const { fp: priorFullFp, wasStale } =
											await loadOrRebuildFingerprint(lessonDir, oldManifest!);

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
												lessonData.contentHtml ?? "",
												newFp?.playbackId ?? lessonData.muxPlaybackId,
											);
											// Track for manifest write (P0-2: persist freshly rebuilt fp)
											lastComputedFullFp = currentFullFp;
										} catch {
											// Fall back to legacy equality check below
										}

										// P1-1: Wire scoreBody into body change detection.
										// scoreBody returns UNCHANGED when either hash is null (no false positives).
										// If MINOR, upgrade textChanged regardless of legacy hash comparison.
										if (!isNewLesson && currentFullFp !== null) {
											const bodyVerdict = scoreBody(
												priorFullFp?.bodyHash ?? null,
												currentFullFp.bodyHash,
											);
											if (bodyVerdict === "MINOR") {
												textChanged = true;
											}
										}

										let shouldRedownload = false;
										let videoStateLabel = "UNKNOWN";
										const remoteFingerprintChanged =
											newFp != null &&
											oldManifest?.videoFingerprint != null &&
											!videoFingerprintsEqual(
												newFp,
												oldManifest.videoFingerprint,
											);

										if (remoteFingerprintChanged) {
											// The full scorer compares local file signals. The remote lightweight
											// fingerprint is the authoritative first check for "the lesson now points
											// at a different video" (Mux playbackId / yt-dlp id / duration).
											shouldRedownload = true;
											videoStateLabel = "REPLACED(remote-fingerprint)";
										} else if (priorFullFp && currentFullFp) {
											const verdict = scoreVideo(priorFullFp, currentFullFp);
											videoStateLabel = verdict.state;

											if (verdict.state === "UNCHANGED") {
												shouldRedownload = false;
											} else if (verdict.state === "REPLACED") {
												shouldRedownload = true;
											} else if (verdict.state === "MINOR_CHANGE") {
												// Ambiguous: escalate to perceptual signals (Phase 3)
												// Cache hit: if prior perceptual data exists and L1–L3 agree,
												// reuse stored data and skip expensive ffmpeg/fpcalc.
												const priorPerceptual: PerceptualFingerprint | null =
													priorFullFp.perceptual ?? null;
												const hasCachedPerceptual =
													priorPerceptual !== null &&
													priorPerceptual !== undefined;
												try {
													const durationMs =
														currentFullFp.ffprobe?.durationMs ?? 0;
													const escalation = await escalatedScore(
														localVideoPath,
														priorPerceptual,
														durationMs,
													);
													// Store the freshly computed perceptual data (P0-3 fix:
													// replaces empty stubs with real frames/audio).
													currentFullFp.perceptual = escalation.computed;
													lastComputedFullFp = currentFullFp;
													// P1-2: perceptual score tiers (Phase 3 doc):
													//   ≥4 → UNCHANGED (perceptual confirms same video)
													//   2–3 → ambiguous (log warning, don't re-download)
													//   ≤1 → REPLACED (perceptual says different video)
													if (escalation.perceptualScore >= 4) {
														shouldRedownload = false;
														videoStateLabel = hasCachedPerceptual
															? "UNCHANGED(perceptual-cached)"
															: "UNCHANGED(perceptual)";
													} else if (escalation.perceptualScore <= 1) {
														// Perceptual signals confirm replacement — upgrade verdict.
														shouldRedownload = true;
														videoStateLabel = "REPLACED(perceptual)";
													} else {
														// Score 2–3: ambiguous; keep MINOR_CHANGE, log a warning.
														shouldRedownload = false;
														videoStateLabel = "MINOR_CHANGE";
														logger.warn(
															`    ⚠️  Ambiguous perceptual score (${escalation.perceptualScore}/5) for lesson "${lesson.title}" — ` +
																`manual inspection recommended. Re-run with --force-update to force re-download.`,
														);
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
											if (
												newFp &&
												!videoFingerprintsEqual(
													newFp,
													oldManifest!.videoFingerprint,
												)
											) {
												shouldRedownload = true;
												videoStateLabel = "REPLACED(legacy)";
											}
										}

										if (shouldRedownload) {
											logger.info(
												`    🔄 Video changed (${videoStateLabel}) — re-downloading`,
											);
											const backupPath = `${videoPath}.bak`;
											if (fs.existsSync(videoPath)) {
												await fs.move(videoPath, backupPath, {
													overwrite: true,
												});
											}
											try {
												updateStatus("Downloading video...");
												await downloader.downloadVideo(
													lessonData.videoLink,
													lessonDir,
													"video",
												);
												if (fs.existsSync(backupPath))
													await fs.remove(backupPath);
												hasVideo = true;
												videoFingerprint = newFp ?? undefined;
												videoChanged = true;
												// Compute fresh full fingerprint after re-download
												try {
													const freshFp = await computeFullFingerprint(
														videoPath,
														lessonData.contentHtml ?? "",
														newFp?.playbackId ?? lessonData.muxPlaybackId,
													);
													await writeFingerprintSidecar(lessonDir, freshFp);
													currentFullFp = freshFp;
													lastComputedFullFp = freshFp;
												} catch {
													// Non-fatal
												}
											} catch (err) {
												logger.warn(
													`    ⚠️ Video re-download failed; restoring previous file`,
												);
												if (fs.existsSync(backupPath)) {
													await fs.move(backupPath, videoPath, {
														overwrite: true,
													});
												}
												hasVideo = true;
												videoFingerprint = oldManifest?.videoFingerprint;
											}
										} else {
											logger.info(
												`    ⏭️  Video unchanged (${videoStateLabel})`,
											);
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
										updateStatus("Downloading video...");
										await downloader.downloadVideo(
											lessonData.videoLink,
											lessonDir,
											"video",
										);
										hasVideo = true;
										if (!videoExistsBefore) {
											videoWasNewlyDownloaded = true;
											const fp = await downloader.getVideoFingerprint(
												lessonData.videoLink,
											);
											if (fp) videoFingerprint = fp;
										}
									} catch (err) {
										logger.warn(
											`    ⚠️ Failed to download video for ${lesson.title}`,
										);
									}
								}
							}

							const resourcesHtml: string[] = [];
							if (lessonData.resources && lessonData.resources.length > 0) {
								const resourcesDir = path.join(lessonDir, "resources");
								await fs.ensureDir(resourcesDir);

								const resTasks = lessonData.resources.map(async (res) => {
									if (!res.downloadUrl) return null;

									if (res.isExternal) {
										logger.info(
											`    🔗 External resource linked: ${res.title}`,
										);
										return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
									}

									try {
										updateStatus("Downloading resources...");
										const safeFileName = sanitizeName(
											res.file_name || res.title,
										);
										const resPath = path.join(resourcesDir, safeFileName);

										if (fs.existsSync(resPath)) {
											const stats = fs.statSync(resPath);
											if (stats.size > 0) {
												logger.info(
													`    ⏭️  Resource already exists, skipping: ${res.title}`,
												);
												return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
											}
										}

										logger.info(`    ⬇️  Downloading resource: ${res.title}`);
										await downloader.downloadAsset(res.downloadUrl, resPath);
										return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
									} catch (err) {
										logger.warn(
											`    ⚠️  Failed to download resource ${res.title}: ${String(err)}`,
										);
										return null;
									}
								});

								const results = await Promise.all(resTasks);
								results.forEach((r) => {
									if (r) resourcesHtml.push(r);
								});
							}

							const isRootLesson = mInfo.moduleDirName.length === 0;
							const groupLink = isRootLesson
								? "../../index.html"
								: "../../../index.html";
							const courseLink = isRootLesson
								? "../index.html"
								: "../../index.html";
							const moduleBreadcrumb = isRootLesson
								? ""
								: `<span>/</span><span>${module.title}</span>`;
							const videoFileName = fs.existsSync(
								path.join(lessonDir, "video.hevc.mp4"),
							)
								? "video.hevc.mp4"
								: "video.mp4";

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
                                        ${hasVideo ? `<video controls src="${videoFileName}"></video>` : ""}
                                        <div class="content">
                                            ${localizedHtml}
                                        </div>
                                        ${
																					resourcesHtml.length > 0
																						? `
                                        <div class="resources">
                                            <h3>Resources / Attachments</h3>
                                            <ul>
                                                ${resourcesHtml.join("")}
                                            </ul>
                                        </div>
                                        `
																						: ""
																				}
                                        <div class="nav">
                                            <a href="${courseLink}">Back to Course Index</a>
                                        </div>
                                    </div>
                                </div>
                            </body>
                            </html>
                        `;

							await fs.writeFile(
								path.join(lessonDir, "index.html"),
								htmlContent,
							);

							updateStatus("Saving metadata...");
							const now = new Date().toISOString();
							const firstDownloadedAt =
								oldManifest?.firstDownloadedAt ?? oldManifest?.updatedAt ?? now;
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
								lastVideoChangedAt,
							};

							await writeAtomicJson(
								path.join(lessonDir, "lesson.json"),
								lessonManifest,
							);

							const eventTypes: LessonEventType[] = [];
							if (isNewLesson) eventTypes.push("lesson-added");
							if (textChanged) eventTypes.push("text-updated");
							if (videoChanged) eventTypes.push("video-updated");

							let outcome: LessonOutcome = "unchanged";
							if (isNewLesson) outcome = "new";
							else if (textChanged && videoChanged) outcome = "both-updated";
							else if (textChanged) outcome = "text-updated";
							else if (videoChanged) outcome = "video-updated";

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
									lastVideoChangedAt,
								},
							};
							stats.changes.push(change);

							completedLessons += 1;
							options.callbacks?.onLessonComplete?.({
								moduleIndex: mInfo.mIndex,
								lessonIndex: lIndex,
								lessonTitle: lesson.title,
								hasVideo,
								resourcesCount: resourcesHtml.length,
							});

							updateStatus("Updating course index...");
							indexLimit(() =>
								regenerateIndex(baseOutputDir, {
									silent: options.suppressIndexLogs,
								}),
							);
						} catch (err) {
							failedLessons += 1;
							stats.failed += 1;
							options.callbacks?.onLessonError?.({
								moduleIndex: mInfo.mIndex,
								lessonIndex: lIndex,
								lessonTitle: lesson.title,
								error: err,
							});
							logger.error(
								`    ⚠️ Error processing lesson ${lesson.title}: ${String(err)}`,
							);
						}
					},
				});
			}
		}

		// P1-4: Progress counter — emit a line every 25 lessons OR every 30 seconds.
		// Lets the user track long runs (e.g. 1318-lesson vaults) without spam.
		const progressStartMs = Date.now();
		let lastProgressLessons = 0;
		let lastProgressMs = progressStartMs;
		const PROGRESS_EVERY_N = 25;
		const PROGRESS_EVERY_MS = 30_000;

		function emitProgress(): void {
			const done = completedLessons;
			const total = totalLessons;
			const elapsedMs = Date.now() - progressStartMs;
			const unchanged =
				done - stats.textsNew - stats.textsUpdated - stats.videosUpdated;
			const stale = stats.textsNew;
			const updated = stats.textsUpdated + stats.videosUpdated;
			const etaStr =
				done > 0
					? (() => {
							const msPerLesson = elapsedMs / done;
							const remaining = Math.round(
								((total - done) * msPerLesson) / 60_000,
							);
							return remaining < 1 ? "<1 min" : `~${remaining} min`;
						})()
					: "?";
			logger.info(
				`🔄 Classified ${done}/${total} lessons` +
					` (${Math.max(0, unchanged)} unchanged, ${stale} new, ${updated} updated)` +
					` ETA ${etaStr}`,
			);
		}

		const progressTimer = setInterval(() => {
			const done = completedLessons;
			const nowMs = Date.now();
			const lessonsBump = done - lastProgressLessons;
			const timeBump = nowMs - lastProgressMs;
			if (lessonsBump >= PROGRESS_EVERY_N || timeBump >= PROGRESS_EVERY_MS) {
				emitProgress();
				lastProgressLessons = done;
				lastProgressMs = nowMs;
			}
		}, 5_000); // poll every 5 s; actual emit gated by the thresholds above

		try {
			if (options.runTasks) {
				await options.runTasks(tasks, concurrency);
			} else {
				await runConcurrent(
					tasks.map((task) => () => task.run()),
					concurrency,
				);
			}
		} finally {
			clearInterval(progressTimer);
		}
		await indexLimit(() =>
			regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }),
		);
		const groupDir = activeGroupDir ?? path.dirname(baseOutputDir);
		await groupIndexLimit(() =>
			regenerateGroupIndex(groupDir, { silent: options.suppressIndexLogs }),
		);

		stats.endedAt = new Date().toISOString();
		try {
			await mergeRunIntoLog(groupDir, stats);
		} catch (err) {
			logger.warn(`⚠️ Failed to update group run log: ${String(err)}`);
		}
		// Re-run group index so chips/badges reflect this run's fresh timestamps.
		await groupIndexLimit(() =>
			regenerateGroupIndex(groupDir, { silent: options.suppressIndexLogs }),
		);

		const summary: DownloadSummary = {
			courseName,
			groupName,
			outputDir: baseOutputDir,
			modulesCount: modules.length,
			lessonsCount: totalLessons,
			completedLessons,
			failedLessons,
			targetLessonId,
		};

		options.callbacks?.onCourseComplete?.(summary);

		printRunReport(stats, logger);

		// ---------------------------------------------------------------------------
		// Phase 1 fix — Layout-fork orphan cleanup (FATAL on failure).
		// Runs only when (a) a layout-fork redirect happened earlier in this run,
		// (b) --allow-layout-fork was set (otherwise we'd have thrown), and
		// (c) the run completed with zero failed lessons. If any lesson failed
		// we leave both layouts intact so the user can diagnose with full data.
		//
		// Cleanup failure throws LayoutForkCleanupError — the caller MUST see
		// it. Previously this was a silent try/catch that left 26 GB of duplicate
		// content on disk and poisoned downstream tooling.
		// ---------------------------------------------------------------------------
		if (layoutForkOrphanCourseDir) {
			if (failedLessons > 0) {
				logger.warn(
					`⚠️ Layout-fork orphan cleanup SKIPPED: ${failedLessons} lesson(s) failed.\n` +
						`   Both layouts left intact for diagnosis:\n` +
						`     canonical: ${baseOutputDir}\n` +
						`     orphan:    ${layoutForkOrphanCourseDir}\n` +
						`   Re-run after resolving failures, or remove the orphan manually.`,
				);
			} else {
				// Sanity guard: never delete a path that is the active output
				// dir, the active group dir, or any ancestor of them. Defense
				// in depth in case the redirect logic ever miscomputes.
				const activeAbs = path.resolve(baseOutputDir);
				const orphanAbs = path.resolve(layoutForkOrphanCourseDir);
				if (
					activeAbs === orphanAbs ||
					activeAbs.startsWith(orphanAbs + path.sep)
				) {
					throw new LayoutForkCleanupError(
						layoutForkOrphanCourseDir,
						new Error(
							`Refusing to remove orphan path because the active output ` +
								`dir "${baseOutputDir}" is inside it. This indicates a bug ` +
								`in the layout-fork redirect logic.`,
						),
					);
				}
				try {
					await fs.remove(layoutForkOrphanCourseDir);
					logger.info(
						`🧹 Removed layout-fork orphan: ${layoutForkOrphanCourseDir}`,
					);
				} catch (err) {
					throw new LayoutForkCleanupError(layoutForkOrphanCourseDir, err);
				}
				if (layoutForkOrphanGroupDir) {
					try {
						const remaining = await fs
							.readdir(layoutForkOrphanGroupDir)
							.catch(() => null);
						if (remaining !== null && remaining.length === 0) {
							await fs.remove(layoutForkOrphanGroupDir);
							logger.info(
								`🧹 Removed empty layout-fork orphan group dir: ${layoutForkOrphanGroupDir}`,
							);
						}
					} catch (err) {
						throw new LayoutForkCleanupError(layoutForkOrphanGroupDir, err);
					}
				}
			}
		}

		return summary;
	} finally {
		await scraper.close();
	}
}
