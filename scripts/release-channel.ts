/**
 * The release channels of VERSIONING.md, as pure functions that
 * .github/workflows/release.yml calls and scripts/release-channel.test.ts covers:
 *
 * - `channelOf` decides whether a version is published from a branch, under
 *   which npm dist-tag, and how its GitHub release is marked;
 * - `nextVersion` gives the version of the Next channel (`-alpha.<run>`),
 *   published on every push to `dev`;
 * - `setVersion` writes one version in every package.json, and the peer ranges
 *   on `@afora/core` that a prerelease needs.
 *
 * The CLI:
 *
 *   bun scripts/release-channel.ts version <v>   # bun run release:version <v>: setVersion, then bun install
 *   bun scripts/release-channel.ts set-version <v>   # setVersion alone (the publish of the Next)
 *   bun scripts/release-channel.ts detect        # the job detect of release.yml
 *
 * `detect` reads BRANCH, RUN_NUMBER, EVENT and BEFORE from the environment, and
 * asks npm for the dist-tags and git for the tags; DIST_TAGS (`latest=0.0.13,rc=...`),
 * TAGS (a comma list) and CHANGED_FILES (a comma list) replace them for a dry
 * run on a machine. It writes its decision to $GITHUB_OUTPUT when that is set.
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
	return checked(decide(input, distTags.latest), distTags, input.version);
}

function decide(
	{ version, branch, tagExists }: ChannelInput,
	latest: string | undefined,
): Channel {
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
			parsed.minor !== Number(minor) ||
			parsed.patch === 0
		) {
			throw new Error(
				`${branch} publishes only patches of its line, ${major}.${minor}.<patch> with a patch of 1 or more, not ${version}`,
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
					? `${version} is a candidate of a patch, so it goes to ${lineTag}`
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
}

/**
 * The version of the Next: the version of package.json without its
 * prerelease, with the minor raised while that one is already released as
 * stable, and `-alpha.<run>`.
 */
export function nextVersion({
	pkgVersion,
	stableTags,
	run,
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
	let { minor, patch } = parsed;
	while (released.has(`${parsed.major}.${minor}.${patch}`)) {
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

async function detect(): Promise<Record<string, string>> {
	const env = process.env;
	const branch = env.BRANCH ?? env.GITHUB_REF_NAME ?? "";
	const manifests = manifestsOf(process.cwd());
	const pkgVersion = manifests[0]?.version as string;

	const distTags =
		env.DIST_TAGS !== undefined
			? Object.fromEntries(
					env.DIST_TAGS.split(",")
						.filter(Boolean)
						.map((pair) => pair.split("=") as [string, string]),
				)
			: distTagsOf(
					await Bun.$`npm view @afora/core dist-tags --json`.nothrow().quiet(),
				);
	const tags =
		env.TAGS !== undefined
			? env.TAGS.split(",").filter(Boolean)
			: (await Bun.$`git ls-remote --tags --refs origin`.quiet())
					.text()
					.split("\n")
					.map((line) => line.split("refs/tags/")[1])
					.filter((tag): tag is string => Boolean(tag));

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

async function main(args: string[]) {
	const [command, version, ...flags] = args;
	if ((command === "version" || command === "set-version") && version) {
		for (const path of setVersion(version)) console.log(`${path}: ${version}`);
		if (command === "version" && !flags.includes("--no-install")) {
			await Bun.$`bun install`;
		}
		return;
	}
	if (command === "detect") {
		const result = await detect();
		const lines = Object.entries(result).map(
			([key, value]) => `${key}=${value}`,
		);
		console.log(lines.join("\n"));
		if (process.env.GITHUB_OUTPUT) {
			writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, {
				flag: "a",
			});
		}
		return;
	}
	console.error(
		"usage: bun scripts/release-channel.ts version <v> [--no-install] | set-version <v> | detect",
	);
	process.exit(2);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: Error) => {
		for (const line of error.message.split("\n"))
			console.error(`::error::${line}`);
		process.exit(1);
	});
}
