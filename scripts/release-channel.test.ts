import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	channelOf,
	nextVersion,
	packageIssues,
	parseVersion,
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
		channelOf({ version, branch: "main", latest, tagExists });

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

	test("the guard applies only to latest", () => {
		expect(main("27.0.0-rc.1", "27.1.0").distTag).toBe("rc");
		expect(main("27.1.0-beta.1", "27.2.0").distTag).toBe("beta");
	});

	test("the first publish has no latest to compare with", () => {
		expect(
			channelOf({ version: "27.0.0", branch: "main", tagExists: false })
				.distTag,
		).toBe("latest");
	});
});

describe("channelOf on release/<YY>.<m>", () => {
	const release = (version: string, latest: string, tagExists = false) =>
		channelOf({ version, branch: "release/27.0", latest, tagExists });

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
			distTag: "v27.0",
			prerelease: false,
			makeLatest: false,
			gitRelease: true,
			bench: false,
		});
	});

	test("rc goes to rc, or to the tag of its line below latest", () => {
		expect(release("27.0.1-rc.1", "27.0.0")).toMatchObject({
			distTag: "rc",
			prerelease: true,
			makeLatest: false,
		});
		expect(release("27.0.4-rc.1", "27.1.0")).toMatchObject({
			distTag: "v27.0",
			prerelease: true,
			makeLatest: false,
		});
	});

	test("alpha, beta and 0.0.N are refused", () => {
		expect(() => release("27.0.1-alpha.1", "27.0.0")).toThrow(
			"publishes stable and rc",
		);
		expect(() => release("27.0.1-beta.1", "27.0.0")).toThrow(
			"publishes stable and rc",
		);
		expect(() => release("0.0.14", "0.0.13")).toThrow("only 27.0.<patch>");
	});

	test("a version of another line is refused", () => {
		expect(() => release("27.1.0", "27.0.0")).toThrow(
			"release/27.0 publishes only 27.0.<patch>, not 27.1.0",
		);
		expect(() => release("28.0.1", "27.0.0")).toThrow("only 27.0.<patch>");
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
				latest: "0.0.13",
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

	test("a stable version keeps the declared ranges", () => {
		const root = fixture();
		setVersion("27.0.0", root);
		expect(read(root).version).toBe("27.0.0");
		expect(read(root, "packages/hono")).toMatchObject({
			version: "27.0.0",
			peerDependencies: { "@afora/core": ">=27.0.0-rc.1" },
		});
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
