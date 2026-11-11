# About these docs

The documentation of afora is the Markdown of this repository: `README.md`, the pages of `docs/`, the READMEs of the packages and a few project files. The website (getafora.com) is built from the same files, so a page reads the same on GitHub and on the site, and a change to the code updates its page in the same pull request. This page says how the content is organized, for readers who want the map and for anyone who adds a page.

## Sections

The site has eight sections, in this order. [`nav.json`](nav.json) lists their pages in reading order.

| Section                | For                                                                                | Pages                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Getting started        | Deciding whether afora fits, installing it, a first API.                           | The [README](../README.md) (what afora is, install on Bun and Node, the quick start), the [overview](README.md).                                                                                                |
| Tutorial and guides    | Learning by building, one task at a time.                                          | [Tutorial](tutorial.md), [Coming from Hono + Zod](coming-from-hono-zod.md), [afora.json](afora-json.md), [Testing](testing.md).                                                                                 |
| Concepts               | Understanding one part fully: what it does, its options, its rules.                | One page per concept, from [Properties](properties.md) to [OpenAPI](openapi.md).                                                                                                                                |
| Recipes                | Solving one common problem with tested code.                                       | [Soft delete](recipes/soft-delete.md), [cursor pagination](recipes/cursor-pagination.md) and the others.                                                                                                        |
| Packages               | Using a companion package: install, options, commands.                             | The README of each package, and the [command line](cli.md) reference.                                                                                                                                           |
| Runtime and deployment | Running on Bun, Node, Workers or a browser.                                        | [Runtime](runtime.md).                                                                                                                                                                                          |
| Reference              | Looking something up: every export, exception, issue code and key of `afora.json`. | [API](reference/api.md), [exceptions](reference/exceptions.md), [issue codes](reference/issue-codes.md), the [afora.json schema](../packages/codegen/afora.schema.json), [API tiers](api-tiers.md).             |
| Project                | How afora is versioned, measured and built.                                        | [Versioning](../VERSIONING.md), [changelog](../CHANGELOG.md), [performance](performance.md), [FAQ](faq.md), [troubleshooting](troubleshooting.md), [glossary](glossary.md), [contributing](../CONTRIBUTING.md). |

## Reading order

A reader new to afora goes through Getting started, then the tutorial, then the concepts in the order of `nav.json`. The concepts build on each other the way the code does:

property → blueprint → record → entity → repository → use case → command → output → application

So each concept page can assume the ones before it, and links to them instead of explaining them again. Guides and recipes link to the concept pages for the details, and the reference pages are reached from anywhere, by search or by a link from a concept.

## Page types

Every page of `nav.json` has a `type`, which tells the site how to present it and tells a writer what the page is for.

| Type        | A page that                                                                         | Written as                                                                                              |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `guide`     | takes the reader through a task from start to end.                                  | Steps in order, each with its code and what it gives. Runs as written.                                  |
| `concept`   | explains one part of afora: what it is, how it behaves, its options and its errors. | The behavior first, then the options. It is the spec of that behavior: a change in behavior changes it. |
| `recipe`    | answers one question ("how do I...?") in a few minutes.                             | The problem in one or two sentences, the solution as tested code, then why it works and its limits.     |
| `reference` | lists things to look up: exports, exceptions, codes, options, commands.             | Tables and short entries, complete. Generated from the code where it can be.                            |
| `project`   | is about the project rather than the API: stability, changes, performance, help.    | Plain prose, kept current with each release.                                                            |

## How the site reads the Markdown

The pages have no frontmatter. The site takes everything it needs from two places:

- **`docs/nav.json`** gives the sections, the order, the title shown in the navigation and the type of each page. Each page is `{ "title", "path", "type" }`, with `path` relative to the root of the repository, so a package README or `CHANGELOG.md` is a page like any other.
- **The page itself** gives the rest: its `# Title` (the first heading) is the title of the page, and its headings make the table of contents and the anchors, as GitHub makes them.

Relative links between pages are written as they work on GitHub (`[Records](records.md#plugins)`), and the site rewrites them to its own URLs. A file that is not Markdown, such as `packages/codegen/afora.schema.json`, is shown as it is.

## Checks

Each kind of content is checked in CI, so the site cannot drift from the code:

- `bun run docs:links`: every relative link and `#anchor` resolves, every path of `nav.json` exists, and every page of `docs/` (apart from `docs/plans/`) is in `nav.json`.
- `bun run docs:code`: every `ts` block of the docs and the package READMEs type-checks against the source. A block that builds on the one before it is marked `<!-- docs:code continue -->`; one that is a fragment on purpose is marked `<!-- docs:code skip: reason -->`.
- `bun run docs:coverage`: every export of the stable, adapters and testing entry points is named on a page.
- `bun run docs:api:check`: the [API reference](reference/api.md) and the [exceptions reference](reference/exceptions.md) are what the code generates (`bun run docs:api` writes them).
- `bun run test:interop`: the quick start of the README, the tutorial and the recipes run against real libraries.

## Adding a page

1. Pick its type and section, and write it in the voice of the pages around it: plain, precise, one name for one thing.
2. Add it to `nav.json`, in its section, at the place a reader should meet it.
3. Link to it from the pages that lead to it, and from the [overview](README.md) if it is a concept.
4. Run `bun run docs:links`, `bun run docs:code` and `bun run docs:coverage`.
