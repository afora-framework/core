/**
 * The release channels of VERSIONING.md, as pure functions that
 * .github/workflows/release.yml calls and scripts/release-channel.test.ts covers:
 *
 * - `channelOf` decides whether a version is published from a branch, under
 *   which npm dist-tag, and how its GitHub release is marked;
 * - `nextVersion` gives the version of the Next channel (`-alpha.<run>`),
 *   published on every push to `dev`;
 * - `setVersion` writes one version in every package.json, and the peer ranges
 *   on `@afora/core` that a prerelease needs;
 * - `preparedVersion` and `datedChangelog` give the version of the next rc,
 *   beta, stable or patch, and date the changelogs for it
 *   (.github/workflows/prepare-release.yml).
 *
 * The CLI:
 *
 *   bun scripts/release-channel.ts version <v>   # bun run release:version <v>: setVersion, then bun install
 *   bun scripts/release-channel.ts set-version <v>   # setVersion alone (the publish of the Next)
 *   bun scripts/release-channel.ts detect        # the job detect of release.yml
 *   bun scripts/release-channel.ts prepare --channel rc [--version <v>] [--date YYYY-MM-DD]
 *       # prepare-release.yml: preparedVersion, datedChangelog, setVersion, bun install
 *   bun scripts/release-channel.ts section <v> [--link-base <url>]   # the section of <v> in CHANGELOG.md
 *
 * `detect` reads BRANCH, RUN_NUMBER, EVENT and BEFORE from the environment;
 * `prepare` reads --branch, else BRANCH, else the current branch. Both ask
 * npm for the dist-tags and git for the tags and the release branches;
 * DIST_TAGS (`latest=0.0.13,rc=...`), TAGS, RELEASE_LINES (`27.0` for
 * release/27.0) and CHANGED_FILES (comma lists) replace them for a dry run on
 * a machine. They write their outputs to $GITHUB_OUTPUT when it is set.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type VersionKind = "zero" | "stable" | "alpha" | "beta" | "rc";

export interface ParsedVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly kind: VersionKind;
}

export interface Channel {
	/** Whether the run publishes anything. */
	readonly publish: boolean;
	/** The npm dist-tag the packages are published under. */
	readonly distTag: string;
	/** Marked as a prerelease (alpha, beta and rc). */
	readonly prerelease: boolean;
	/** Marked as the latest GitHub release. */
	readonly makeLatest: boolean;
	/** Creates the `v<version>` tag and the GitHub release (all but alpha). */
	readonly gitRelease: boolean;
	/** Runs the benchmark job after the publish (what goes to `latest` or `rc`). */
	readonly bench: boolean;
	readonly reason: string;
}

const NUMBER = "(0|[1-9][0-9]*)";
// 0.0.<n> before 27.0, then <YY>.<minor>.<patch> with an optional
// -(alpha|beta|rc).<n>, where YY (the year of the cycle) is 27 or more.
const SCHEME = new RegExp(
	`^(?:0\\.0\\.${NUMBER}|(2[7-9]|[3-9][0-9]|[1-9][0-9]{2,})\\.${NUMBER}\\.${NUMBER}(?:-(alpha|beta|rc)\\.${NUMBER})?)$`,
);

const TAG_OF: Record<VersionKind, string> = {
	zero: "latest",
	stable: "latest",
	alpha: "next",
	beta: "beta",
	rc: "rc",
};

/** The version in the scheme of VERSIONING.md, or undefined outside it. */
export function parseVersion(version: string): ParsedVersion | undefined {
	const match = SCHEME.exec(version);
	if (!match) return undefined;
	if (match[1] !== undefined) {
		return { major: 0, minor: 0, patch: Number(match[1]), kind: "zero" };
	}
	return {
		major: Number(match[2]),
		minor: Number(match[3]),
		patch: Number(match[4]),
		kind: (match[5] as VersionKind | undefined) ?? "stable",
	};
}

function parseOrThrow(version: string): ParsedVersion {
	const parsed = parseVersion(version);
	if (!parsed) {
		throw new Error(
			`${version} is not in the scheme of VERSIONING.md: 0.0.<n>, or <YY>.<minor>.<patch>[-(alpha|beta|rc).<n>] with YY >= 27`,
		);
	}
	return parsed;
}

const behind = (version: string, current: string | undefined) =>
	current !== undefined && Bun.semver.order(version, current) === -1;

/**
 * Whether npm would read `tag` as a semver range, which it refuses as a
 * dist-tag (`npm dist-tag add` and `npm publish --tag` check
 * `semver.validRange`): anything that starts like a version or a comparator
 * (`v27.0`, `27`, `x`, `^1`, `>=2`, `*`).
 */
export function isSemverRange(tag: string): boolean {
	const trimmed = tag.trim();
	return trimmed === "" || /^[<>=~^v\s]*[0-9xX*]/.test(trimmed);
}

/** The kinds of version each dist-tag holds, to tell its own from a leftover. */
const KINDS_OF: Record<string, readonly VersionKind[]> = {
	latest: ["zero", "stable"],
	next: ["alpha"],
	beta: ["beta"],
	rc: ["rc"],
};

/**
 * Throws when publishing `version` under `distTag` would move that tag
 * backwards. A tag that holds a version of another channel (the `next` of the
 * rc before the channels) is taken over.
 */
function guardTag(
	version: string,
	distTag: string,
	distTags: Readonly<Record<string, string>>,
) {
	const current = distTags[distTag];
	if (current === undefined || !behind(version, current)) return;
	const kinds = KINDS_OF[distTag];
	const kind = parseVersion(current)?.kind;
	if (kinds && (kind === undefined || !kinds.includes(kind))) return;
	throw new Error(
		`${version} is behind ${current}, the ${distTag} on npm; a dist-tag never moves backwards`,
	);
}

function checked(
	channel: Channel,
	distTags: Readonly<Record<string, string>>,
	version: string,
): Channel {
	if (isSemverRange(channel.distTag)) {
		throw new Error(
			`${channel.distTag} is a semver range, which npm refuses as a dist-tag`,
		);
	}
	if (channel.publish) guardTag(version, channel.distTag, distTags);
	return channel;
}

const RELEASE_BRANCH = /^release\/([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface ChannelInput {
	readonly version: string;
	readonly branch: string;
	/** The dist-tags of `@afora/core` on npm (none before the first publish). */
	readonly distTags?: Readonly<Record<string, string>>;
	/** Whether the tag `v<version>` exists. */
	readonly tagExists: boolean;
}

/** How `version` is released from `branch`. Throws when it may not be. */
export function channelOf(input: ChannelInput): Channel {
	const distTags = input.distTags ?? {};
	return checked(decide(input, distTags), distTags, input.version);
}

function decide(
	{ version, branch, tagExists }: ChannelInput,
	distTags: Readonly<Record<string, string>>,
): Channel {
	const latest = distTags.latest;
	const parsed = parseOrThrow(version);
	const prerelease = parsed.kind !== "stable" && parsed.kind !== "zero";
	const mapped = TAG_OF[parsed.kind];

	if (branch === "dev") {
		if (parsed.kind !== "alpha") {
			throw new Error(
				`dev publishes only the Next (-alpha.<n>), not ${version}`,
			);
		}
		return {
			publish: true,
			distTag: mapped,
			prerelease: true,
			makeLatest: false,
			gitRelease: false,
			bench: false,
			reason: `${version} goes to next`,
		};
	}

	const skip = (reason: string): Channel => ({
		publish: false,
		distTag: mapped,
		prerelease,
		makeLatest: false,
		gitRelease: false,
		bench: false,
		reason,
	});

	if (branch === "main") {
		if (parsed.kind === "alpha") {
			throw new Error(
				`main publishes stable, beta and rc versions; ${version} is an alpha, which only dev publishes`,
			);
		}
		// The tag is created last, so a missing tag also means an unfinished release.
		if (tagExists) return skip(`v${version} is already released`);
		// No dist-tag moves backwards: checked() refuses it.
		return {
			publish: true,
			distTag: mapped,
			prerelease,
			makeLatest: !prerelease,
			gitRelease: true,
			bench: mapped === "latest" || mapped === "rc",
			reason: `${version} goes to ${mapped}`,
		};
	}

	const line = RELEASE_BRANCH.exec(branch);
	if (line) {
		const [, major, minor] = line;
		if (
			parsed.kind === "zero" ||
			parsed.major !== Number(major) ||
			parsed.minor !== Number(minor)
		) {
			throw new Error(
				`${branch} publishes only versions of its line, ${major}.${minor}.<patch>, not ${version}`,
			);
		}
		if (parsed.kind !== "stable" && parsed.kind !== "rc") {
			throw new Error(
				`${branch} publishes stable and rc versions, not ${version}`,
			);
		}
		if (tagExists) return skip(`v${version} is already released`);
		// The tag of the line: never a semver range such as v27.0, which npm refuses.
		const lineTag = `release-${major}.${minor}`;
		// A candidate of the first release of the line (`27.0.0-rc.7`, once the
		// line has its branch) is the rc of the next release: it goes to rc, as
		// from main, unless rc already holds a newer candidate.
		const rcAhead =
			behind(version, distTags.rc) &&
			parseVersion(distTags.rc as string)?.kind === "rc";
		if (parsed.patch === 0 && prerelease && !rcAhead) {
			return {
				publish: true,
				distTag: "rc",
				prerelease: true,
				makeLatest: false,
				gitRelease: true,
				bench: true,
				reason: `${version} is a candidate of the first release of ${major}.${minor}, so it goes to rc`,
			};
		}
		// A candidate of a patch, and a patch behind latest, get the tag of their
		// line, so that neither rc nor latest move to an older line.
		if (prerelease || behind(version, latest)) {
			return {
				publish: true,
				distTag: lineTag,
				prerelease,
				makeLatest: false,
				gitRelease: true,
				bench: false,
				reason: prerelease
					? parsed.patch === 0
						? `${version} is behind ${distTags.rc}, the rc on npm, so it goes to ${lineTag}`
						: `${version} is a candidate of a patch, so it goes to ${lineTag}`
					: `${version} is behind ${latest}, the latest on npm, so it goes to ${lineTag}`,
			};
		}
		return {
			publish: true,
			distTag: "latest",
			prerelease: false,
			makeLatest: true,
			gitRelease: true,
			bench: true,
			reason: `${version} goes to latest`,
		};
	}

	throw new Error(
		`releases come from main, release/<YY>.<minor> or dev, not ${branch}`,
	);
}

export interface NextInput {
	/** The version of package.json on dev. */
	readonly pkgVersion: string;
	/** The stable versions already released (with or without a leading `v`). */
	readonly stableTags: readonly string[];
	/** The number of the run (GITHUB_RUN_NUMBER), which only grows. */
	readonly run: number;
	/** The lines with a release branch (`27.0` for release/27.0). */
	readonly lines?: readonly string[];
}

/**
 * The version of the Next: the version of package.json without its
 * prerelease, with the minor raised while that one is already released as
 * stable or its line has a release branch (it is finished there, while dev
 * moves on), and `-alpha.<run>`.
 */
export function nextVersion({
	pkgVersion,
	stableTags,
	run,
	lines = [],
}: NextInput): string {
	const parsed = parseOrThrow(pkgVersion);
	if (parsed.kind === "zero") {
		throw new Error(
			`the Next needs a <YY>.<minor>.<patch> version, not ${pkgVersion}`,
		);
	}
	if (!Number.isInteger(run) || run < 0) {
		throw new Error(`the run number must be a whole number, not ${run}`);
	}
	const released = new Set(stableTags.map((tag) => tag.replace(/^v/, "")));
	const branched = new Set(lines);
	let { minor, patch } = parsed;
	while (
		released.has(`${parsed.major}.${minor}.${patch}`) ||
		branched.has(`${parsed.major}.${minor}`)
	) {
		minor += 1;
		patch = 0;
	}
	return `${parsed.major}.${minor}.${patch}-alpha.${run}`;
}

/** Whether a push to dev that changed `files` publishes the Next. */
export function touchesNext(files: readonly string[]): boolean {
	return files.some(
		(file) =>
			file === "package.json" ||
			file.startsWith("src/") ||
			/^packages\/[^/]+\/src\//.test(file),
	);
}

interface Manifest {
	readonly path: string;
	readonly name: string;
	readonly version: string;
	readonly corePeer?: string;
}

function manifestsOf(root: string): Manifest[] {
	const packages = join(root, "packages");
	const dirs = existsSync(packages)
		? readdirSync(packages, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isDirectory() &&
						existsSync(join(packages, entry.name, "package.json")),
				)
				.map((entry) => join(packages, entry.name))
				.sort()
		: [];
	return [root, ...dirs].map((dir) => {
		const path = join(dir, "package.json");
		const json = JSON.parse(readFileSync(path, "utf8"));
		return {
			path,
			name: json.name,
			version: json.version,
			corePeer: json.peerDependencies?.["@afora/core"],
		};
	});
}

/**
 * Problems that stop `version` from being released: a package at another
 * version, or a peer range on `@afora/core` that does not accept it.
 */
export function packageIssues(
	version: string,
	manifests: readonly Pick<Manifest, "name" | "version" | "corePeer">[],
	{ peers = true }: { readonly peers?: boolean } = {},
): string[] {
	const issues: string[] = [];
	for (const manifest of manifests) {
		if (manifest.version !== version) {
			issues.push(`${manifest.name} is at ${manifest.version}, not ${version}`);
		}
		if (
			peers &&
			manifest.corePeer !== undefined &&
			!Bun.semver.satisfies(version, manifest.corePeer)
		) {
			issues.push(
				`${manifest.name} needs @afora/core ${manifest.corePeer}, which ${version} does not satisfy`,
			);
		}
	}
	return issues;
}

/**
 * Writes `version` in package.json and in every packages/* /package.json, and
 * the peer range on `@afora/core` that `peerRangeOf` gives. The rest of each
 * file is left as it is.
 */
/**
 * The peer range on `@afora/core` of the packages of `version`: `^<version>`
 * for a stable `YY.m.p` (the same major, which keeps the contract), and
 * `>=<version>` for a prerelease (a prerelease satisfies only a range that
 * names one of the same `YY.m.p`) and for `0.0.<n>`.
 */
export function peerRangeOf(version: string): string {
	const { kind } = parseOrThrow(version);
	return kind === "stable" ? `^${version}` : `>=${version}`;
}

export function setVersion(version: string, root = process.cwd()): string[] {
	const peer = peerRangeOf(version);
	const written: string[] = [];
	for (const { path, corePeer } of manifestsOf(root)) {
		let text = readFileSync(path, "utf8");
		const top = /^(\t"version":\s*")[^"]*(")/m;
		if (!top.test(text)) throw new Error(`${path} has no top-level version`);
		text = text.replace(top, `$1${version}$2`);
		if (corePeer !== undefined) {
			text = text.replace(
				/("peerDependencies":\s*\{[^}]*?"@afora\/core":\s*")[^"]*(")/,
				`$1${peer}$2`,
			);
		}
		writeFileSync(path, text);
		written.push(path);
	}
	return written;
}

/** The channels a release can be prepared for (`prepare`, prepare-release.yml). */
export const PREPARE_CHANNELS = ["rc", "beta", "stable", "patch"] as const;
export type PrepareChannel = (typeof PREPARE_CHANNELS)[number];

export interface PrepareInput {
	/** rc, beta, stable or patch; anything else is refused. */
	readonly channel: string;
	/** The version of package.json on `branch`. */
	readonly pkgVersion: string;
	/** The git tags (with or without a leading `v`). */
	readonly tags: readonly string[];
	/** The dist-tags of `@afora/core` on npm. */
	readonly distTags?: Readonly<Record<string, string>>;
	/** The base of the bump: dev, or release/<YY>.<minor> for its line. */
	readonly branch: string;
	/** The lines with a release branch (`27.0` for release/27.0). */
	readonly lines?: readonly string[];
	/** A version to use instead of the computed one (empty means none). */
	readonly explicit?: string;
}

export interface Prepared {
	readonly version: string;
	/** The branch whose push publishes it: main from dev, the release branch itself. */
	readonly publishBranch: string;
	/** How it is published from `publishBranch`. */
	readonly channel: Channel;
}

const triple = ({ major, minor, patch }: ParsedVersion) =>
	`${major}.${minor}.${patch}`;

const prereleaseNumber = (version: string) =>
	Number(/\.([0-9]+)$/.exec(version)?.[1] ?? 0);

/** The kinds of version each channel may prepare. */
const PREPARED_KINDS: Record<PrepareChannel, readonly VersionKind[]> = {
	rc: ["rc"],
	beta: ["beta"],
	stable: ["stable", "zero"],
	patch: ["stable", "rc"],
};

/**
 * The version a release of `channel` gets, from the version of package.json
 * on `branch`:
 *
 * - rc and beta: the next candidate of the target (`27.0.0-rc.1` →
 *   `27.0.0-rc.2`), or its first (`<target>-rc.1`). The target is the version
 *   without its prerelease, with the minor raised while it is released as
 *   stable or its line has a release branch (on dev), or the patch raised
 *   while it is released (on release/<YY>.<minor>). A beta after an rc of the
 *   same target is refused.
 * - stable: the prerelease stripped (`27.0.0-rc.3` → `27.0.0`).
 * - patch, on release/<YY>.<minor> only: `YY.m.p` → `YY.m.(p+1)`, and the rc
 *   of a patch → that patch.
 *
 * beta is prepared on dev only; rc and stable on dev, or on the release
 * branch of their line, which publishes them itself. Once a line has its
 * release branch, dev prepares nothing of that line.
 *
 * Every version, computed or `explicit`, is checked: in the scheme, of the
 * kind of its channel, after the version of package.json, not released, and
 * accepted by `channelOf` on the branch that publishes it (which refuses a
 * dist-tag moving backwards). Throws otherwise.
 */
export function preparedVersion(input: PrepareInput): Prepared {
	const { channel, pkgVersion, branch } = input;
	if (!(PREPARE_CHANNELS as readonly string[]).includes(channel)) {
		throw new Error(
			`the channel is one of ${PREPARE_CHANNELS.join(", ")}, not "${channel}"`,
		);
	}
	const kind = channel as PrepareChannel;
	const line = RELEASE_BRANCH.exec(branch);
	if (kind === "patch" && !line) {
		throw new Error(
			`a patch is prepared on release/<YY>.<minor>, not on ${branch}`,
		);
	}
	if (kind === "beta" && branch !== "dev") {
		throw new Error(
			`the channel beta is prepared on dev (and published from main), not on ${branch}; release/<YY>.<minor> takes rc, stable and patch`,
		);
	}
	if ((kind === "rc" || kind === "stable") && branch !== "dev" && !line) {
		throw new Error(
			`the channel ${kind} is prepared on dev (and published from main) or on release/<YY>.<minor>, not on ${branch}`,
		);
	}
	const lines = new Set(input.lines ?? []);
	const current = parseOrThrow(pkgVersion);
	const released = new Set(input.tags.map((tag) => tag.replace(/^v/, "")));
	const explicit = input.explicit?.trim();
	// A version bumped but never published would be skipped: its tag (or, for a
	// release that failed halfway, the dist-tag that holds it) tells.
	const published =
		released.has(pkgVersion) ||
		Object.values(input.distTags ?? {}).includes(pkgVersion);
	if (
		!explicit &&
		!published &&
		current.kind !== "alpha" &&
		current.kind !== "zero"
	) {
		throw new Error(
			`${pkgVersion} is bumped but not released yet; merge the release pull request first, or pass --version`,
		);
	}

	const version = explicit
		? explicit
		: computedVersion(kind, pkgVersion, current, released, line, lines);

	const parsed = parseOrThrow(version);
	const ofLine = `${parsed.major}.${parsed.minor}`;
	if (!line && lines.has(ofLine)) {
		throw new Error(
			`the line ${ofLine} has its branch release/${ofLine}: prepare ${version} there, not on ${branch}`,
		);
	}
	if (!PREPARED_KINDS[kind].includes(parsed.kind)) {
		throw new Error(
			`${version} is not a version of the channel ${kind} (${PREPARED_KINDS[kind].join(" or ")})`,
		);
	}
	if (
		parsed.kind === "beta" &&
		current.kind === "rc" &&
		triple(parsed) === triple(current)
	) {
		throw new Error(
			`${pkgVersion} is already an rc of ${triple(current)}; a beta of it would go back from rc to beta`,
		);
	}
	if (Bun.semver.order(version, pkgVersion) !== 1) {
		throw new Error(
			`${version} is not after ${pkgVersion}, the version on ${branch}; a release never goes backwards`,
		);
	}
	if (released.has(version)) {
		throw new Error(`v${version} is already released`);
	}
	const publishBranch = line ? branch : "main";
	return {
		version,
		publishBranch,
		channel: channelOf({
			version,
			branch: publishBranch,
			distTags: input.distTags,
			tagExists: false,
		}),
	};
}

function computedVersion(
	kind: PrepareChannel,
	pkgVersion: string,
	current: ParsedVersion,
	released: ReadonlySet<string>,
	line: RegExpExecArray | null,
	lines: ReadonlySet<string>,
): string {
	if (kind === "patch") {
		const [, major, minor] = line as RegExpExecArray;
		if (current.major !== Number(major) || current.minor !== Number(minor)) {
			throw new Error(
				`${pkgVersion} is not of the line ${major}.${minor} of release/${major}.${minor}`,
			);
		}
		if (current.kind === "stable") {
			return `${current.major}.${current.minor}.${current.patch + 1}`;
		}
		if (current.kind === "rc") return triple(current);
		throw new Error(
			`a release branch holds stable and rc versions, not ${pkgVersion}`,
		);
	}
	if (kind === "stable") {
		if (
			current.kind !== "rc" &&
			current.kind !== "beta" &&
			current.kind !== "alpha"
		) {
			throw new Error(
				`${pkgVersion} is not a prerelease; a stable release strips the prerelease of an rc or a beta (or pass --version)`,
			);
		}
		const stable = triple(current);
		if (released.has(stable)) {
			throw new Error(`${stable} is already released as stable`);
		}
		return stable;
	}
	if (current.kind === "zero") {
		throw new Error(
			`the channel ${kind} needs a <YY>.<minor>.<patch> version to start from, not ${pkgVersion}; pass --version`,
		);
	}
	let { minor, patch } = current;
	if (line) {
		const [, major, lineMinor] = line;
		if (current.major !== Number(major) || minor !== Number(lineMinor)) {
			throw new Error(
				`${pkgVersion} is not of the line ${major}.${lineMinor} of release/${major}.${lineMinor}`,
			);
		}
		// a release branch stays on its line: the next patch, never a minor
		while (released.has(`${current.major}.${minor}.${patch}`)) patch += 1;
	} else {
		while (
			released.has(`${current.major}.${minor}.${patch}`) ||
			lines.has(`${current.major}.${minor}`)
		) {
			minor += 1;
			patch = 0;
		}
	}
	const target = `${current.major}.${minor}.${patch}`;
	if (current.kind === kind && triple(current) === target) {
		return `${target}-${kind}.${prereleaseNumber(pkgVersion) + 1}`;
	}
	return `${target}-${kind}.1`;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first `## <version>` heading of `text` (a version of the scheme). */
function firstVersionHeading(text: string): string | undefined {
	for (const match of text.matchAll(/^## (\S+)/gm)) {
		const version = match[1] as string;
		if (parseVersion(version)) return version;
	}
	return undefined;
}

function emptySection(version: string, previous: string | undefined): string {
	const parsed = parseOrThrow(version);
	if (parsed.kind !== "stable" && parsed.kind !== "zero") {
		return previous
			? `A candidate of ${triple(parsed)}, with no changes since ${previous}.`
			: `A candidate of ${triple(parsed)}.`;
	}
	if (
		previous &&
		parseVersion(previous) &&
		previous.startsWith(`${version}-`)
	) {
		return `The stable release of ${previous}, with no changes since.`;
	}
	return previous ? `No changes since ${previous}.` : "No changes of its own.";
}

/** The anchor of a heading, as GitHub and scripts/check-doc-links.ts make it. */
const slugOf = (heading: string) =>
	heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s/g, "-");

/**
 * For a stable version, the candidates it went through since the previous
 * stable: the prereleases of the same version among the headings of `tail`,
 * up to the first stable one, linked to their sections.
 */
function sinceSummary(version: string, tail: string): string | undefined {
	const parsed = parseOrThrow(version);
	if (parsed.kind !== "stable") return undefined;
	const candidates: string[] = [];
	let previous: string | undefined;
	for (const match of tail.matchAll(/^## (\S+)([^\n]*)$/gm)) {
		const heading = `${match[1]}${match[2]}`.trim();
		const other = parseVersion(match[1] as string);
		if (!other) continue;
		if (other.kind === "stable" || other.kind === "zero") {
			previous = match[1];
			break;
		}
		if (triple(other) === version) {
			candidates.unshift(
				`[${match[1]}](#${slugOf(heading.replace(/`/g, ""))})`,
			);
		}
	}
	if (candidates.length === 0) return undefined;
	const list =
		candidates.length === 1
			? candidates[0]
			: `${candidates.slice(0, -1).join(", ")} and ${candidates.at(-1)}`;
	return `Since ${previous ?? "the first release"}, it went through ${list}; their sections below list the changes.`;
}

/**
 * The changelog with its `## Unreleased` section dated as `## <version> —
 * <date>`. Without one (or with an empty one), a short section is written
 * instead, before the first `## ` heading, which says that a prerelease is a
 * candidate with no changes since the previous version; `note` is added to
 * it. A stable version after candidates opens with a "Since <previous stable>"
 * line that links to their sections. Entries are never dropped. Throws when `version` already has a section.
 */
export function datedChangelog(
	text: string,
	version: string,
	date: string,
	{ note }: { readonly note?: string } = {},
): string {
	parseOrThrow(version);
	if (!isDate(date)) throw new Error(`${date} is not a date (YYYY-MM-DD)`);
	if (new RegExp(`^## v?${escaped(version)}(?:\\s|$)`, "m").test(text)) {
		throw new Error(`the changelog already has a section for ${version}`);
	}
	const heading = `## ${version} — ${date}`;
	const short = (previous: string | undefined) =>
		[emptySection(version, previous), note].filter(Boolean).join(" ");

	const unreleased = /^## Unreleased\b[^\n]*(?:\n|$)/im.exec(text);
	if (unreleased) {
		const start = unreleased.index;
		const after = start + unreleased[0].length;
		const rest = text.slice(after);
		const next = rest.search(/^## /m);
		const body = next === -1 ? rest : rest.slice(0, next);
		const tail = rest.slice(body.length);
		const since = sinceSummary(version, tail);
		if (body.trim()) {
			const summary = since ? `\n${since}\n` : "";
			return `${text.slice(0, start)}${heading}\n${summary}${rest}`;
		}
		const section = `${heading}\n\n${short(firstVersionHeading(tail))}\n${since ? `\n${since}\n` : ""}`;
		return `${text.slice(0, start)}${section}${tail ? `\n${tail}` : ""}`;
	}
	const since = sinceSummary(version, text);
	const section = `${heading}\n\n${short(firstVersionHeading(text))}\n${since ? `\n${since}\n` : ""}`;
	const first = text.search(/^## /m);
	if (first === -1) return `${text.trimEnd()}\n\n${section}`;
	return `${text.slice(0, first)}${section}\n${text.slice(first)}`;
}

/**
 * The body of the `## <version>` section of a changelog, trimmed. With
 * `linkBase` (the URL of the changelog), links to its headings become
 * absolute, for a pull request body.
 */
export function changelogSection(
	text: string,
	version: string,
	{ linkBase }: { readonly linkBase?: string } = {},
): string {
	const heading = new RegExp(
		`^## v?${escaped(version)}(?:\\s[^\\n]*)?$`,
		"m",
	).exec(text);
	if (!heading) {
		throw new Error(`the changelog has no section for ${version}`);
	}
	const rest = text.slice(heading.index + heading[0].length);
	const next = rest.search(/^## /m);
	const body = (next === -1 ? rest : rest.slice(0, next)).trim();
	return linkBase ? body.replaceAll("](#", `](${linkBase}#`) : body;
}

function isDate(date: string): boolean {
	if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return false;
	const parsed = new Date(`${date}T00:00:00Z`);
	return (
		!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date)
	);
}

/** The dist-tags of `@afora/core` on npm, or those of DIST_TAGS (`latest=0.0.13,rc=...`). */
async function readDistTags(): Promise<Record<string, string>> {
	const list = process.env.DIST_TAGS;
	if (list !== undefined) {
		return Object.fromEntries(
			list
				.split(",")
				.filter(Boolean)
				.map((pair) => pair.split("=") as [string, string]),
		);
	}
	return distTagsOf(
		await Bun.$`npm view @afora/core dist-tags --json`.nothrow().quiet(),
	);
}

/** The git tags of origin, or those of TAGS (a comma list). */
async function readTags(): Promise<string[]> {
	const list = process.env.TAGS;
	if (list !== undefined) return list.split(",").filter(Boolean);
	return (await Bun.$`git ls-remote --tags --refs origin`.quiet())
		.text()
		.split("\n")
		.map((line) => line.split("refs/tags/")[1])
		.filter((tag): tag is string => Boolean(tag));
}

/**
 * The lines with a release branch on origin (`27.0` for release/27.0), or
 * those of RELEASE_LINES (a comma list).
 */
async function readLines(): Promise<string[]> {
	const list = process.env.RELEASE_LINES;
	if (list !== undefined) return list.split(",").filter(Boolean);
	return linesOf(
		(
			await Bun.$`git ls-remote --heads origin refs/heads/release/*`.quiet()
		).text(),
	);
}

/** The lines of the release branches in the output of `git ls-remote --heads`. */
export function linesOf(lsRemote: string): string[] {
	return lsRemote
		.split("\n")
		.map((entry) => entry.split("refs/heads/")[1] ?? "")
		.map((branch) => RELEASE_BRANCH.exec(branch))
		.filter((match): match is RegExpExecArray => match !== null)
		.map(([, major, minor]) => `${major}.${minor}`);
}

async function detect(): Promise<Record<string, string>> {
	const env = process.env;
	const branch = env.BRANCH ?? env.GITHUB_REF_NAME ?? "";
	const manifests = manifestsOf(process.cwd());
	const pkgVersion = manifests[0]?.version as string;

	const distTags = await readDistTags();
	const tags = await readTags();

	if (branch === "dev") {
		// The Next is written by setVersion, peers included; package.json only
		// has to hold together.
		const issues = packageIssues(pkgVersion, manifests, { peers: false });
		if (issues.length) throw new Error(issues.join("\n"));
		const files = await changedFiles();
		if (files && !touchesNext(files)) {
			return {
				publish: "false",
				reason:
					"the push changed nothing under src/, packages/*/src/ or package.json",
			};
		}
		const version = nextVersion({
			pkgVersion,
			stableTags: tags.filter(
				(tag) => parseVersion(tag.slice(1))?.kind === "stable",
			),
			run: Number(env.RUN_NUMBER ?? env.GITHUB_RUN_NUMBER ?? 0),
			lines: await readLines(),
		});
		return outputs(
			version,
			channelOf({ version, branch, distTags, tagExists: false }),
		);
	}

	const channel = channelOf({
		version: pkgVersion,
		branch,
		distTags,
		tagExists: tags.includes(`v${pkgVersion}`),
	});
	const issues = packageIssues(pkgVersion, manifests);
	if (channel.publish && issues.length) throw new Error(issues.join("\n"));
	return outputs(pkgVersion, channel);
}

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: { toString(): string };
	readonly stderr: { toString(): string };
}

/**
 * The dist-tags from `npm view <package> dist-tags --json`. Only a package
 * that is not on npm (E404) has none; any other failure throws, so that a
 * registry outage is never read as "no latest" and lets a tag move backwards.
 */
export function distTagsOf(result: CommandResult): Record<string, string> {
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		if (/\bE404\b/.test(`${stdout}\n${stderr}`)) return {};
		throw new Error(
			`npm view failed (exit ${result.exitCode}): ${stderr.trim() || stdout.trim()}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`npm view gave no JSON: ${stdout.trim()}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!Object.values(parsed).every((value) => typeof value === "string")
	) {
		throw new Error(`npm view gave no dist-tags: ${stdout.trim()}`);
	}
	return parsed as Record<string, string>;
}

function outputs(version: string, channel: Channel): Record<string, string> {
	return {
		publish: String(channel.publish),
		version,
		"dist-tag": channel.distTag,
		prerelease: String(channel.prerelease),
		"make-latest": String(channel.makeLatest),
		"git-release": String(channel.gitRelease),
		bench: String(channel.bench),
		reason: channel.reason,
	};
}

/** The files of the push, or undefined when they are not known (publish then). */
async function changedFiles(): Promise<string[] | undefined> {
	const env = process.env;
	if (env.CHANGED_FILES !== undefined) {
		return env.CHANGED_FILES.split(",").filter(Boolean);
	}
	const before = env.BEFORE;
	if (env.EVENT !== "push" || !before || /^0+$/.test(before)) return undefined;
	await Bun.$`git fetch --quiet --depth=1 origin ${before}`.nothrow().quiet();
	const diff = await Bun.$`git diff --name-only ${before} HEAD`
		.nothrow()
		.quiet();
	if (diff.exitCode !== 0) return undefined;
	return diff.text().split("\n").filter(Boolean);
}

/** Prints `key=value` lines, and appends them to $GITHUB_OUTPUT when it is set. */
function emit(result: Record<string, string>) {
	const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`);
	console.log(lines.join("\n"));
	if (process.env.GITHUB_OUTPUT) {
		writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {
			flag: "a",
		});
	}
}

const PREPARE_FLAGS = ["channel", "version", "date", "branch"] as const;

function prepareFlags(args: readonly string[]) {
	const values: Partial<Record<(typeof PREPARE_FLAGS)[number], string>> = {};
	let install = true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--no-install") {
			install = false;
			continue;
		}
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
		const name = match?.[1] as (typeof PREPARE_FLAGS)[number] | undefined;
		if (!name || !PREPARE_FLAGS.includes(name)) {
			throw new Error(`unknown argument ${arg}`);
		}
		const value = match?.[2] ?? args[++i];
		if (value === undefined) throw new Error(`--${name} needs a value`);
		values[name] = value;
	}
	return { ...values, install };
}

/** The changelogs `prepare` dates: CHANGELOG.md, then packages/* /CHANGELOG.md. */
function changelogsOf(root: string): string[] {
	return manifestsOf(root)
		.map(({ path }) => join(path, "..", "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

/**
 * `prepare`: computes the version of the release (`preparedVersion`), dates
 * the changelogs, writes the version (`setVersion`) and runs `bun install`.
 * Nothing is written when a check fails.
 */
async function prepare(
	args: readonly string[],
): Promise<Record<string, string>> {
	const flags = prepareFlags(args);
	if (!flags.channel) {
		throw new Error(`--channel is required: ${PREPARE_CHANNELS.join(", ")}`);
	}
	const date = flags.date ?? new Date().toISOString().slice(0, 10);
	if (!isDate(date))
		throw new Error(`--date ${date} is not a date (YYYY-MM-DD)`);
	const root = process.cwd();
	const branch =
		flags.branch ||
		process.env.BRANCH ||
		(await Bun.$`git rev-parse --abbrev-ref HEAD`.quiet()).text().trim();
	const pkgVersion = manifestsOf(root)[0]?.version as string;

	const prepared = preparedVersion({
		channel: flags.channel,
		pkgVersion,
		branch,
		explicit: flags.version,
		tags: await readTags(),
		distTags: await readDistTags(),
		lines: await readLines(),
	});
	const { version } = prepared;
	const changelogs = changelogsOf(root).map((path) => ({
		path,
		text: datedChangelog(readFileSync(path, "utf8"), version, date, {
			note:
				path === join(root, "CHANGELOG.md")
					? undefined
					: "See the [root CHANGELOG](../../CHANGELOG.md).",
		}),
	}));

	for (const path of setVersion(version, root)) {
		console.error(`${path}: ${version}`);
	}
	for (const { path, text } of changelogs) {
		writeFileSync(path, text);
		console.error(`${path}: ## ${version} — ${date}`);
	}
	if (flags.install) await Bun.$`bun install`.quiet();
	return {
		version,
		"dist-tag": prepared.channel.distTag,
		"publish-branch": prepared.publishBranch,
		prerelease: String(prepared.channel.prerelease),
		date,
	};
}

const USAGE = `usage: bun scripts/release-channel.ts
  version <v> [--no-install]   setVersion, then bun install (bun run release:version)
  set-version <v>              setVersion alone (the publish of the Next)
  detect                       the job detect of release.yml
  prepare --channel <rc|beta|stable|patch> [--version <v>] [--date YYYY-MM-DD] [--branch <b>] [--no-install]
  section <v> [--link-base <url>]   the section of <v> in CHANGELOG.md`;

async function main(args: string[]) {
	const [command, version, ...flags] = args;
	if ((command === "version" || command === "set-version") && version) {
		for (const path of setVersion(version)) console.log(`${path}: ${version}`);
		if (command === "version" && !flags.includes("--no-install")) {
			await Bun.$`bun install`;
		}
		return;
	}
	if (command === "detect") return emit(await detect());
	if (command === "prepare") return emit(await prepare(args.slice(1)));
	if (command === "section" && version) {
		const [flag, linkBase] = flags;
		if (flag !== undefined && (flag !== "--link-base" || !linkBase)) {
			throw new Error("usage: section <v> [--link-base <url>]");
		}
		console.log(
			changelogSection(readFileSync("CHANGELOG.md", "utf8"), version, {
				linkBase,
			}),
		);
		return;
	}
	console.error(USAGE);
	process.exit(2);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: Error) => {
		for (const line of error.message.split("\n"))
			console.error(`::error::${line}`);
		process.exit(1);
	});
}
