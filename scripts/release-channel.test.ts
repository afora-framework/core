import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changelogSection,
	channelOf,
	datedChangelog,
	distTagsOf,
	isSemverRange,
	nextVersion,
	packageIssues,
	parseVersion,
	peerRangeOf,
	preparedVersion,
	setVersion,
	touchesNext,
} from "./release-channel.ts";

describe("parseVersion", () => {
	test("accepts the scheme of VERSIONING.md", () => {
		expect(parseVersion("0.0.13")?.kind).toBe("zero");
		expect(parseVersion("27.0.0")?.kind).toBe("stable");
		expect(parseVersion("27.1.0-alpha.42")?.kind).toBe("alpha");
		expect(parseVersion("27.1.0-beta.1")?.kind).toBe("beta");
		expect(parseVersion("27.0.0-rc.1")?.kind).toBe("rc");
		expect(parseVersion("100.2.3")).toEqual({
			major: 100,
			minor: 2,
			patch: 3,
			kind: "stable",
		});
	});

	test("refuses what is outside it", () => {
		for (const version of [
			"1.0.0",
			"26.0.0",
			"0.1.0",
			"0.0.1-rc.1",
			"27.0.0-gamma.1",
			"27.0.0-rc",
			"27.01.0",
			"v27.0.0",
		]) {
			expect(parseVersion(version)).toBeUndefined();
		}
		expect(() =>
			channelOf({ version: "1.0.0", branch: "main", tagExists: false }),
		).toThrow("not in the scheme");
	});
});

describe("channelOf on main", () => {
	const main = (version: string, latest = "0.0.13", tagExists = false) =>
		channelOf({ version, branch: "main", distTags: { latest }, tagExists });

	test("0.0.N and stable go to latest, marked latest, with the bench", () => {
		for (const version of ["0.0.14", "27.0.0"]) {
			expect(main(version)).toMatchObject({
				publish: true,
				distTag: "latest",
				prerelease: false,
				makeLatest: true,
				gitRelease: true,
				bench: true,
			});
		}
	});

	test("rc goes to rc, a prerelease, with the bench", () => {
		expect(main("27.0.0-rc.1")).toMatchObject({
			publish: true,
			distTag: "rc",
			prerelease: true,
			makeLatest: false,
			gitRelease: true,
			bench: true,
		});
	});

	test("beta goes to beta, a prerelease, without the bench", () => {
		expect(main("27.1.0-beta.2")).toMatchObject({
			publish: true,
			distTag: "beta",
			prerelease: true,
			makeLatest: false,
			gitRelease: true,
			bench: false,
		});
	});

	test("alpha is refused: only dev publishes it", () => {
		expect(() => main("27.1.0-alpha.3")).toThrow("only dev publishes");
	});

	test("a released version publishes nothing", () => {
		expect(main("27.0.0", "0.0.13", true)).toMatchObject({
			publish: false,
			gitRelease: false,
		});
	});

	test("latest never moves backwards", () => {
		expect(() => main("27.0.0", "27.1.0")).toThrow("behind 27.1.0");
		expect(() => main("0.0.12")).toThrow("behind 0.0.13");
	});

	test("the latest guard applies only to latest", () => {
		expect(main("27.0.0-rc.1", "27.1.0").distTag).toBe("rc");
		expect(main("27.1.0-beta.1", "27.2.0").distTag).toBe("beta");
	});

	test("rc and beta never move backwards either", () => {
		const at = (version: string, distTags: Record<string, string>) =>
			channelOf({ version, branch: "main", distTags, tagExists: false });
		expect(() => at("27.1.0-rc.1", { rc: "27.1.0-rc.2" })).toThrow(
			"behind 27.1.0-rc.2, the rc on npm",
		);
		expect(() => at("27.1.0-beta.1", { beta: "27.2.0-beta.1" })).toThrow(
			"the beta on npm",
		);
		expect(at("27.1.0-rc.3", { rc: "27.1.0-rc.2" }).distTag).toBe("rc");
	});

	test("the first publish has no latest to compare with", () => {
		expect(
			channelOf({ version: "27.0.0", branch: "main", tagExists: false })
				.distTag,
		).toBe("latest");
	});
});

describe("channelOf on release/<YY>.<m>", () => {
	const release = (
		version: string,
		latest: string,
		tagExists = false,
		distTags: Record<string, string> = {},
	) =>
		channelOf({
			version,
			branch: "release/27.0",
			distTags: { latest, ...distTags },
			tagExists,
		});

	test("a patch at or above latest goes to latest", () => {
		expect(release("27.0.1", "27.0.0")).toMatchObject({
			publish: true,
			distTag: "latest",
			prerelease: false,
			makeLatest: true,
			gitRelease: true,
		});
	});

	test("a patch below latest goes to the tag of its line, not marked latest", () => {
		expect(release("27.0.3", "27.1.0")).toMatchObject({
			publish: true,
			distTag: "release-27.0",
			prerelease: false,
			makeLatest: false,
			gitRelease: true,
			bench: false,
		});
	});

	test("an rc of a patch goes to the tag of its line, without the bench", () => {
		for (const latest of ["27.0.0", "27.1.0"]) {
			expect(release("27.0.4-rc.1", latest)).toMatchObject({
				distTag: "release-27.0",
				prerelease: true,
				makeLatest: false,
				gitRelease: true,
				bench: false,
			});
		}
	});

	test("the tag of the line never moves backwards", () => {
		expect(() =>
			release("27.0.2", "27.1.0", false, { "release-27.0": "27.0.3" }),
		).toThrow("behind 27.0.3, the release-27.0 on npm");
	});

	test("x.y.0, its candidates and other majors are refused", () => {
		expect(() => release("27.0.0", "0.0.13")).toThrow("only patches");
		expect(() => release("27.0.0-rc.2", "0.0.13")).toThrow("only patches");
		expect(() => release("28.0.1", "27.0.0")).toThrow("only patches");
	});

	test("alpha, beta and 0.0.N are refused", () => {
		expect(() => release("27.0.1-alpha.1", "27.0.0")).toThrow(
			"publishes stable and rc",
		);
		expect(() => release("27.0.1-beta.1", "27.0.0")).toThrow(
			"publishes stable and rc",
		);
		expect(() => release("0.0.14", "0.0.13")).toThrow("only patches");
	});

	test("a version of another line is refused", () => {
		expect(() => release("27.1.1", "27.0.0")).toThrow(
			"release/27.0 publishes only patches of its line, 27.0.<patch> with a patch of 1 or more, not 27.1.1",
		);
	});

	test("a released version publishes nothing", () => {
		expect(release("27.0.1", "27.1.0", true).publish).toBe(false);
	});
});

describe("channelOf on dev", () => {
	test("alpha goes to next, with no git tag nor GitHub release", () => {
		expect(
			channelOf({
				version: "27.0.0-alpha.7",
				branch: "dev",
				distTags: { latest: "0.0.13" },
				tagExists: false,
			}),
		).toEqual({
			publish: true,
			distTag: "next",
			prerelease: true,
			makeLatest: false,
			gitRelease: false,
			bench: false,
			reason: "27.0.0-alpha.7 goes to next",
		});
	});

	test("anything but alpha is refused", () => {
		for (const version of [
			"0.0.14",
			"27.0.0",
			"27.0.0-beta.1",
			"27.0.0-rc.1",
		]) {
			expect(() =>
				channelOf({ version, branch: "dev", tagExists: false }),
			).toThrow("only the Next");
		}
	});
});

test("channelOf refuses other branches", () => {
	for (const branch of [
		"feat/x",
		"release/27",
		"release/27.0.1",
		"bench-results/now",
	]) {
		expect(() =>
			channelOf({ version: "27.0.0", branch, tagExists: false }),
		).toThrow("releases come from");
	}
});

describe("nextVersion", () => {
	test("the base is package.json without its prerelease", () => {
		expect(
			nextVersion({ pkgVersion: "27.0.0-rc.1", stableTags: [], run: 12 }),
		).toBe("27.0.0-alpha.12");
		expect(
			nextVersion({ pkgVersion: "27.1.0", stableTags: ["v27.0.0"], run: 3 }),
		).toBe("27.1.0-alpha.3");
	});

	test("a base released as stable raises the minor", () => {
		expect(
			nextVersion({ pkgVersion: "27.0.0", stableTags: ["v27.0.0"], run: 40 }),
		).toBe("27.1.0-alpha.40");
		expect(
			nextVersion({
				pkgVersion: "27.0.2",
				stableTags: ["27.0.2", "v27.1.0"],
				run: 41,
			}),
		).toBe("27.2.0-alpha.41");
	});

	test("0.0.N has no Next", () => {
		expect(() =>
			nextVersion({ pkgVersion: "0.0.13", stableTags: [], run: 1 }),
		).toThrow("needs a <YY>");
	});
});

test("touchesNext: src, packages/*/src and package.json only", () => {
	expect(touchesNext(["src/index.ts"])).toBe(true);
	expect(touchesNext(["packages/hono/src/index.ts"])).toBe(true);
	expect(touchesNext(["package.json"])).toBe(true);
	expect(touchesNext(["docs/runtime.md", "README.md", "CHANGELOG.md"])).toBe(
		false,
	);
	expect(
		touchesNext(["packages/hono/README.md", "packages/hono/package.json"]),
	).toBe(false);
	expect(touchesNext([])).toBe(false);
});

describe("packageIssues", () => {
	const pkg = (version: string, corePeer?: string) => ({
		name: "@afora/hono",
		version,
		corePeer,
	});

	test("every package shares the version", () => {
		expect(packageIssues("27.0.0", [pkg("27.0.0", ">=27.0.0")])).toEqual([]);
		expect(packageIssues("27.0.1", [pkg("27.0.0")])).toEqual([
			"@afora/hono is at 27.0.0, not 27.0.1",
		]);
	});

	test("every peer range accepts the version", () => {
		expect(packageIssues("27.0.0", [pkg("27.0.0", ">=27.0.0-rc.1")])).toEqual(
			[],
		);
		expect(
			packageIssues("27.1.0-rc.1", [pkg("27.1.0-rc.1", ">=27.0.0")]),
		).toEqual([
			"@afora/hono needs @afora/core >=27.0.0, which 27.1.0-rc.1 does not satisfy",
		]);
		expect(
			packageIssues("27.1.0-rc.1", [pkg("27.1.0-rc.1", ">=27.0.0")], {
				peers: false,
			}),
		).toEqual([]);
	});
});

describe("setVersion", () => {
	const fixture = () => {
		const root = mkdtempSync(join(tmpdir(), "release-channel-"));
		const write = (dir: string, json: object) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "package.json"),
				`${JSON.stringify(json, null, "\t")}\n`,
			);
		};
		write(root, {
			name: "@afora/core",
			version: "27.0.0-rc.1",
			peerDependencies: { typebox: "^1" },
		});
		write(join(root, "packages/hono"), {
			name: "@afora/hono",
			version: "27.0.0-rc.1",
			devDependencies: { "@afora/core": "workspace:*" },
			peerDependencies: {
				hono: "^4.13.14",
				"@afora/core": ">=27.0.0-rc.1",
				typebox: "^1",
			},
		});
		write(join(root, "packages/mcp"), {
			name: "@afora/mcp",
			version: "27.0.0-rc.1",
			dependencies: { "@afora/codegen": "workspace:*" },
			peerDependencies: { "@afora/core": ">=27.0.0-rc.1" },
		});
		return root;
	};
	const read = (root: string, dir = ".") =>
		JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));

	test("a prerelease writes the version and peers >=<version>", () => {
		const root = fixture();
		expect(setVersion("27.1.0-alpha.9", root)).toHaveLength(3);
		expect(read(root).version).toBe("27.1.0-alpha.9");
		expect(read(root).peerDependencies).toEqual({ typebox: "^1" });
		const hono = read(root, "packages/hono");
		expect(hono.version).toBe("27.1.0-alpha.9");
		expect(hono.peerDependencies).toEqual({
			hono: "^4.13.14",
			"@afora/core": ">=27.1.0-alpha.9",
			typebox: "^1",
		});
		expect(hono.devDependencies["@afora/core"]).toBe("workspace:*");
		expect(read(root, "packages/mcp").peerDependencies["@afora/core"]).toBe(
			">=27.1.0-alpha.9",
		);
		expect(read(root, "packages/mcp").dependencies["@afora/codegen"]).toBe(
			"workspace:*",
		);
	});

	test("rc to stable: the peers become ^<version>, within the major", () => {
		const root = fixture();
		setVersion("27.0.0", root);
		expect(read(root).version).toBe("27.0.0");
		const hono = read(root, "packages/hono");
		expect(hono).toMatchObject({
			version: "27.0.0",
			peerDependencies: { "@afora/core": "^27.0.0" },
		});
		expect(packageIssues("27.0.0", [{ ...hono, corePeer: "^27.0.0" }])).toEqual(
			[],
		);
		expect(Bun.semver.satisfies("28.0.0", "^27.0.0")).toBe(false);
		expect(Bun.semver.satisfies("27.3.1", "^27.0.0")).toBe(true);
	});

	test("peerRangeOf", () => {
		expect(peerRangeOf("27.1.2")).toBe("^27.1.2");
		expect(peerRangeOf("27.1.0-rc.1")).toBe(">=27.1.0-rc.1");
		expect(peerRangeOf("27.1.0-alpha.4")).toBe(">=27.1.0-alpha.4");
		expect(peerRangeOf("0.0.14")).toBe(">=0.0.14");
	});

	test("the rest of each file is left as it is", () => {
		const root = fixture();
		const before = readFileSync(
			join(root, "packages/hono/package.json"),
			"utf8",
		);
		setVersion("27.0.0-beta.1", root);
		const after = readFileSync(
			join(root, "packages/hono/package.json"),
			"utf8",
		);
		expect(after).toBe(
			before
				.replace('"version": "27.0.0-rc.1"', '"version": "27.0.0-beta.1"')
				.replace('">=27.0.0-rc.1"', '">=27.0.0-beta.1"'),
		);
	});

	test("a version outside the scheme is refused", () => {
		expect(() => setVersion("1.2.3", fixture())).toThrow("not in the scheme");
	});
});

describe("dist-tags", () => {
	test("isSemverRange follows what npm refuses as a dist-tag", () => {
		for (const range of [
			"v27.0",
			"27",
			"27.0",
			"x",
			"*",
			"^1",
			">=2",
			"~1.2",
			"",
		]) {
			expect(isSemverRange(range)).toBe(true);
		}
		for (const tag of ["latest", "next", "beta", "rc", "release-27.0"]) {
			expect(isSemverRange(tag)).toBe(false);
		}
	});

	test("no dist-tag produced is a semver range", () => {
		const cases: [string, string, Record<string, string>][] = [
			["0.0.14", "main", { latest: "0.0.13" }],
			["27.0.0", "main", { latest: "0.0.13" }],
			["27.0.0-rc.1", "main", {}],
			["27.1.0-beta.1", "main", {}],
			["27.1.0-alpha.3", "dev", {}],
			["27.0.1", "release/27.0", { latest: "27.0.0" }],
			["27.0.2", "release/27.0", { latest: "27.1.0" }],
			["27.0.2-rc.1", "release/27.0", { latest: "27.1.0" }],
		];
		for (const [version, branch, distTags] of cases) {
			const { distTag } = channelOf({
				version,
				branch,
				distTags,
				tagExists: false,
			});
			expect(isSemverRange(distTag)).toBe(false);
		}
	});

	test("next is taken over from a version of another channel", () => {
		expect(
			channelOf({
				version: "27.0.0-alpha.3",
				branch: "dev",
				distTags: { next: "27.0.0-rc.1" },
				tagExists: false,
			}).distTag,
		).toBe("next");
		expect(() =>
			channelOf({
				version: "27.0.0-alpha.3",
				branch: "dev",
				distTags: { next: "27.0.0-alpha.9" },
				tagExists: false,
			}),
		).toThrow("behind 27.0.0-alpha.9, the next on npm");
	});

	const result = (exitCode: number, stdout: string, stderr = "") => ({
		exitCode,
		stdout,
		stderr,
	});

	test("distTagsOf reads the dist-tags", () => {
		expect(
			distTagsOf(result(0, '{"latest":"0.0.13","rc":"27.0.0-rc.1"}')),
		).toEqual({ latest: "0.0.13", rc: "27.0.0-rc.1" });
	});

	test("distTagsOf: only E404 means no dist-tags", () => {
		expect(
			distTagsOf(
				result(
					1,
					'{"error":{"code":"E404","summary":"Not Found"}}',
					"npm error code E404",
				),
			),
		).toEqual({});
	});

	test("distTagsOf: any other failure throws", () => {
		expect(() => distTagsOf(result(1, "", "npm error code ETIMEDOUT"))).toThrow(
			"npm view failed (exit 1): npm error code ETIMEDOUT",
		);
		expect(() => distTagsOf(result(1, "", "npm error code E500"))).toThrow(
			"npm view failed",
		);
		expect(() => distTagsOf(result(0, "<html>"))).toThrow("no JSON");
		expect(() => distTagsOf(result(0, '"0.0.13"'))).toThrow("no dist-tags");
	});
});

describe("preparedVersion", () => {
	const DIST_TAGS = { latest: "0.0.13", rc: "27.0.0-rc.1" };
	const TAGS = ["v0.0.12", "v0.0.13", "v27.0.0-rc.1"];
	const prepare = (
		channel: string,
		pkgVersion: string,
		{
			tags = TAGS,
			distTags = DIST_TAGS as Record<string, string>,
			branch = "dev",
			explicit,
		}: {
			tags?: string[];
			distTags?: Record<string, string>;
			branch?: string;
			explicit?: string;
		} = {},
	) =>
		preparedVersion({ channel, pkgVersion, tags, distTags, branch, explicit });
	const version = (...args: Parameters<typeof prepare>) =>
		prepare(...args).version;

	test("rc: the next candidate of the same target", () => {
		const prepared = prepare("rc", "27.0.0-rc.1");
		expect(prepared.version).toBe("27.0.0-rc.2");
		expect(prepared.publishBranch).toBe("main");
		expect(prepared.channel).toMatchObject({ publish: true, distTag: "rc" });
		expect(
			version("rc", "27.0.0-rc.9", {
				tags: [...TAGS, "v27.0.0-rc.9"],
				distTags: { latest: "0.0.13", rc: "27.0.0-rc.9" },
			}),
		).toBe("27.0.0-rc.10");
	});

	test("rc: the first candidate when the version is not an rc of the target", () => {
		expect(version("rc", "27.1.0-beta.2")).toBe("27.1.0-rc.1");
		// an unreleased stable in package.json: its rc would go backwards
		expect(() => prepare("rc", "27.1.0")).toThrow("is not after 27.1.0");
	});

	test("rc: a target released as stable moves to the next minor", () => {
		const tags = [...TAGS, "v27.0.0", "v27.1.0"];
		const distTags = { latest: "27.1.0", rc: "27.0.0-rc.3" };
		expect(version("rc", "27.0.0", { tags, distTags })).toBe("27.2.0-rc.1");
		expect(version("rc", "27.0.0-rc.3", { tags, distTags })).toBe(
			"27.2.0-rc.1",
		);
	});

	test("beta: the same scheme with -beta.<n>", () => {
		expect(version("beta", "27.1.0-beta.1")).toBe("27.1.0-beta.2");
		expect(version("beta", "27.1.0-alpha.3")).toBe("27.1.0-beta.1");
		expect(
			version("beta", "27.0.0", {
				tags: [...TAGS, "v27.0.0"],
				distTags: { latest: "27.0.0" },
			}),
		).toBe("27.1.0-beta.1");
		expect(prepare("beta", "27.1.0-beta.1").channel.distTag).toBe("beta");
	});

	test("beta: refused after an rc of the same target", () => {
		expect(() => prepare("beta", "27.0.0-rc.1")).toThrow(
			"already an rc of 27.0.0",
		);
		expect(() =>
			prepare("beta", "27.0.0-rc.1", { explicit: "27.0.0-beta.5" }),
		).toThrow("already an rc of 27.0.0");
	});

	test("stable: the prerelease stripped", () => {
		const prepared = prepare("stable", "27.0.0-rc.3", {
			tags: [...TAGS, "v27.0.0-rc.3"],
		});
		expect(prepared.version).toBe("27.0.0");
		expect(prepared.channel).toMatchObject({
			distTag: "latest",
			makeLatest: true,
		});
		expect(version("stable", "27.1.0-beta.2")).toBe("27.1.0");
	});

	test("stable: refused for a version that is not a prerelease", () => {
		expect(() => prepare("stable", "27.0.0")).toThrow("is not a prerelease");
		expect(() => prepare("stable", "0.0.13")).toThrow("is not a prerelease");
	});

	test("stable: refused when the stable already exists", () => {
		expect(() =>
			prepare("stable", "27.0.0-rc.3", { tags: [...TAGS, "v27.0.0"] }),
		).toThrow("27.0.0 is already released as stable");
	});

	test("patch: the next patch of the line of the release branch", () => {
		const tags = [...TAGS, "v27.0.0", "v27.0.1"];
		const prepared = prepare("patch", "27.0.1", {
			tags,
			distTags: { latest: "27.0.1" },
			branch: "release/27.0",
		});
		expect(prepared).toMatchObject({
			version: "27.0.2",
			publishBranch: "release/27.0",
			channel: { distTag: "latest" },
		});
		expect(
			version("patch", "27.0.0", {
				tags: [...TAGS, "v27.0.0"],
				distTags: { latest: "27.0.0" },
				branch: "release/27.0",
			}),
		).toBe("27.0.1");
		// behind latest: the tag of the line
		expect(
			prepare("patch", "27.0.1", {
				tags,
				distTags: { latest: "27.1.0" },
				branch: "release/27.0",
			}).channel.distTag,
		).toBe("release-27.0");
		// the rc of a patch becomes that patch
		expect(
			version("patch", "27.0.2-rc.1", {
				tags,
				distTags: { latest: "27.0.1" },
				branch: "release/27.0",
			}),
		).toBe("27.0.2");
	});

	test("patch: only on release/<YY>.<minor>, of its line", () => {
		expect(() => prepare("patch", "27.0.1")).toThrow(
			"a patch is prepared on release/<YY>.<minor>, not on dev",
		);
		expect(() =>
			prepare("patch", "27.1.0", { branch: "release/27.0" }),
		).toThrow("not of the line 27.0");
		expect(() =>
			prepare("patch", "27.0.1-beta.1", { branch: "release/27.0" }),
		).toThrow("holds stable and rc versions");
	});

	test("rc, beta and stable only on dev", () => {
		for (const channel of ["rc", "beta", "stable"]) {
			expect(() =>
				prepare(channel, "27.0.0-rc.1", { branch: "release/27.0" }),
			).toThrow("is prepared on dev");
			expect(() => prepare(channel, "27.0.0-rc.1", { branch: "main" })).toThrow(
				"is prepared on dev",
			);
		}
	});

	test("an unknown channel is refused", () => {
		expect(() => prepare("next", "27.0.0-rc.1")).toThrow(
			'the channel is one of rc, beta, stable, patch, not "next"',
		);
		expect(() => prepare("", "27.0.0-rc.1")).toThrow("the channel is one of");
	});

	test("rc and beta need a <YY> version to start from", () => {
		expect(() => prepare("rc", "0.0.13")).toThrow("pass --version");
		expect(version("rc", "0.0.13", { explicit: "27.0.0-rc.2" })).toBe(
			"27.0.0-rc.2",
		);
	});

	test("explicit: used as given when it passes the checks", () => {
		expect(version("rc", "27.0.0-rc.1", { explicit: "27.0.0-rc.4" })).toBe(
			"27.0.0-rc.4",
		);
		expect(version("rc", "27.0.0-rc.1", { explicit: " " })).toBe("27.0.0-rc.2");
		expect(version("stable", "27.0.0-rc.1", { explicit: "27.0.0" })).toBe(
			"27.0.0",
		);
		expect(
			version("patch", "27.0.1", {
				tags: [...TAGS, "v27.0.0", "v27.0.1"],
				distTags: { latest: "27.0.1" },
				branch: "release/27.0",
				explicit: "27.0.2-rc.1",
			}),
		).toBe("27.0.2-rc.1");
	});

	test("explicit: outside the scheme or of another channel", () => {
		expect(() => prepare("rc", "27.0.0-rc.1", { explicit: "1.2.3" })).toThrow(
			"not in the scheme",
		);
		expect(() =>
			prepare("rc", "27.0.0-rc.1", { explicit: "27.0.0-beta.2" }),
		).toThrow("not a version of the channel rc");
		expect(() =>
			prepare("stable", "27.0.0-rc.1", { explicit: "27.1.0-rc.1" }),
		).toThrow("not a version of the channel stable");
		expect(() =>
			prepare("beta", "27.0.0-rc.1", { explicit: "27.1.0-alpha.3" }),
		).toThrow("not a version of the channel beta");
	});

	test("explicit: channelOf rules of the branch that publishes it", () => {
		expect(() =>
			prepare("patch", "27.0.1", {
				tags: [...TAGS, "v27.0.0", "v27.0.1"],
				branch: "release/27.0",
				explicit: "27.1.0",
			}),
		).toThrow("publishes only patches of its line");
	});

	test("explicit: never backwards", () => {
		expect(() =>
			prepare("rc", "27.0.0-rc.3", { explicit: "27.0.0-rc.2" }),
		).toThrow("is not after 27.0.0-rc.3");
		expect(() =>
			prepare("rc", "27.0.0-rc.3", { explicit: "27.0.0-rc.3" }),
		).toThrow("is not after 27.0.0-rc.3");
		// a dist-tag ahead of package.json
		expect(() =>
			prepare("rc", "27.0.0-rc.1", {
				distTags: { latest: "0.0.13", rc: "27.0.0-rc.5" },
				explicit: "27.0.0-rc.3",
			}),
		).toThrow("behind 27.0.0-rc.5, the rc on npm");
		expect(() =>
			prepare("stable", "27.0.0-rc.1", {
				distTags: { latest: "27.1.0" },
			}),
		).toThrow("behind 27.1.0, the latest on npm");
	});

	test("a version already tagged is refused", () => {
		expect(() =>
			prepare("rc", "27.0.0-rc.1", {
				tags: [...TAGS, "v27.0.0-rc.2"],
			}),
		).toThrow("v27.0.0-rc.2 is already released");
	});
});

describe("datedChangelog", () => {
	const ROOT = `# Changelog

## Unreleased

### Fixed

- A fix.

## 27.0.0-rc.1 — 2026-11-16

The first candidate.
`;
	const PACKAGE = `# Changelog

## 27.0.0-rc.1 — 2026-11-16

The first candidate.
`;

	test("dates the Unreleased section, entries kept", () => {
		expect(datedChangelog(ROOT, "27.0.0-rc.2", "2026-11-20")).toBe(
			ROOT.replace("## Unreleased", "## 27.0.0-rc.2 — 2026-11-20"),
		);
	});

	test("an Unreleased heading with more text, at the end of the file", () => {
		expect(
			datedChangelog(
				"# Changelog\n\n## unreleased (draft)\n\n- An entry.\n",
				"27.1.0",
				"2026-12-01",
			),
		).toBe("# Changelog\n\n## 27.1.0 — 2026-12-01\n\n- An entry.\n");
	});

	test("no Unreleased section: a prerelease is a candidate with no changes", () => {
		expect(datedChangelog(PACKAGE, "27.0.0-rc.2", "2026-11-20")).toBe(
			`# Changelog

## 27.0.0-rc.2 — 2026-11-20

A candidate of 27.0.0, with no changes since 27.0.0-rc.1.

## 27.0.0-rc.1 — 2026-11-16

The first candidate.
`,
		);
	});

	test("the note is added to the short section only", () => {
		const note = "See the [root CHANGELOG](../../CHANGELOG.md).";
		expect(datedChangelog(PACKAGE, "27.0.0", "2026-12-01", { note })).toContain(
			"## 27.0.0 — 2026-12-01\n\nThe stable release of 27.0.0-rc.1, with no changes since. See the [root CHANGELOG](../../CHANGELOG.md).\n\n## 27.0.0-rc.1",
		);
		expect(
			datedChangelog(ROOT, "27.0.0", "2026-12-01", { note }),
		).not.toContain(note);
	});

	test("an empty Unreleased section gets the short section", () => {
		const text =
			"# Changelog\n\n## Unreleased\n\n## 27.0.0 — 2026-12-01\n\nThe release.\n";
		expect(datedChangelog(text, "27.0.1", "2026-12-05")).toBe(
			"# Changelog\n\n## 27.0.1 — 2026-12-05\n\nNo changes since 27.0.0.\n\n## 27.0.0 — 2026-12-01\n\nThe release.\n",
		);
		expect(datedChangelog(text, "27.1.0-rc.1", "2026-12-05")).toContain(
			"A candidate of 27.1.0, with no changes since 27.0.0.",
		);
	});

	test("a changelog with no release yet", () => {
		expect(datedChangelog("# Changelog\n", "27.0.0-rc.1", "2026-11-16")).toBe(
			"# Changelog\n\n## 27.0.0-rc.1 — 2026-11-16\n\nA candidate of 27.0.0.\n",
		);
		expect(datedChangelog("# Changelog\n", "27.0.0", "2026-11-16")).toContain(
			"No changes of its own.",
		);
	});

	test("refuses a version that has a section, a bad date or version", () => {
		expect(() => datedChangelog(PACKAGE, "27.0.0-rc.1", "2026-11-20")).toThrow(
			"already has a section for 27.0.0-rc.1",
		);
		expect(() => datedChangelog(ROOT, "27.0.0-rc.2", "2026-13-01")).toThrow(
			"is not a date",
		);
		expect(() => datedChangelog(ROOT, "27.0.0-rc.2", "20/11/2026")).toThrow(
			"is not a date",
		);
		expect(() => datedChangelog(ROOT, "1.0.0", "2026-11-20")).toThrow(
			"not in the scheme",
		);
	});

	test("changelogSection gives the body of a section", () => {
		const dated = datedChangelog(ROOT, "27.0.0-rc.2", "2026-11-20");
		expect(changelogSection(dated, "27.0.0-rc.2")).toBe(
			"### Fixed\n\n- A fix.",
		);
		expect(changelogSection(dated, "27.0.0-rc.1")).toBe("The first candidate.");
		expect(() => changelogSection(dated, "27.0.0")).toThrow(
			"no section for 27.0.0",
		);
	});
});
