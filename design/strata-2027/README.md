# New brand in the repository: README banner, social preview and symbol

**Labels:** `documentation`, `design`, `good for agents`

## Context
The project has a new visual identity, **Strata Matéria**. The symbol keeps its seed silhouette, now filled with a sediment gradient: ocre on top, terracotta in the middle, moss and lagoon at the bottom, with the cursor line in ink. This issue brings it into `afora-framework/core`.

- **The site and admin changes** have their own issues in `website` and `cms`.

## Start here (Claude Code)
Everything this issue needs is in the repository, so no outside access is required. The design canvas mentioned in earlier notes is private and **not needed**.

```bash
git fetch origin design/strata-2027
git worktree add ../strata-2027 origin/design/strata-2027   # read-only copy of the files, outside your working tree
ls ../strata-2027/design/strata-2027
```

The folder `design/strata-2027/` in that branch has:

| Folder | What it is | How to use it |
|---|---|---|
| `deliverables/` | **Files that ship in the product**, at their target paths | copy them as they are (table below) |
| `static/*.html` | **The spec.** Static HTML snapshots of each screen, script-free, with the font and symbols bundled | open them in a browser or with Playwright, read their markup and CSS, measure them |
| `assets/` | Screenshots of the same states | quick visual reference |
| `shared/` | `strata-tokens.css`, `strata-materials.css`, `tokens.json`, `fonts/recursive.woff2`, symbol SVGs | the design tokens and materials to bring in |
| `reference/` | Every cover export (GitHub, README, OpenGraph) with usage notes (`LEIA-ME.md`) | extra formats, if needed |

**Snapshots:** `Banner2027`, `Banner2027Dark`, `Social2027`, `OpenGraph2027`.

**Branch rules:** the `design/strata-2027` branch holds only these files and is never merged. Do the work on a branch off `dev` and open the PR into `dev`, following `CLAUDE.md`.

### Files that go into the product

| From `deliverables/` | To | What |
|---|---|---|
| `deliverables/.github/assets/*` | `.github/assets/` | afora-banner-light.png and -dark.png (2560×640), plus brand/*.svg (fluid symbol, mono, app icon) |
| `deliverables/github-settings/afora-social-preview.jpg` | **Settings → General → Social preview** (manual) | 1280×640, under 1 MB; a light version sits next to it |
| `deliverables/github-settings/afora-org-avatar.png` | **Organization avatar** (manual): github.com/organizations/afora-framework/settings/profile → Profile picture | 1024×1024, square with no rounded corners (GitHub rounds it), the fluid symbol on basalt |

### Definition of done
- **Shipped files:** every file in `deliverables/` is in place and loads, with no 404s in the network panel. For the website, that includes the favicon on light and dark tabs and the OG preview in a link debugger.
- **Visual match:** each snapshot has a matching page or state, checked side by side at the same width (`tools/compare.ts`).
- **Repo checks:** `CLAUDE.md` conventions are followed (EN/PT strings, Biome, CHANGELOG), and lint, typecheck and build pass.

## Attached files

| Path | What it is |
|---|---|
| `assets/afora-banner-light.png`, `assets/afora-banner-dark.png` | README banner, 2560×640 (1280×320 at 2×) |
| `assets/afora-social-preview.jpg` | GitHub social preview, 1280×640, under 1 MB |
| `reference/github/afora-social-preview-light.jpg` | Light alternative |
| `reference/opengraph/og*.jpg` | OpenGraph covers (EN, PT-BR, dark) |
| `reference/LEIA-ME.md` | Notes on how to use each file |
| `shared/afora-symbol-fluid-{light,dark}.svg`, `shared/afora-app-icon.svg` | New symbol and app icon |

## Step-by-step guide (for an AI agent)
1. **Add the files.** Copy `deliverables/.github/assets/` into the repo, so the banners land in `.github/assets/` and the symbols in `.github/assets/brand/`.
2. **README banner.** Replace the current header image or title block at the top of `README.md` with:

   ```html
   <p align="center">
     <picture>
       <source media="(prefers-color-scheme: dark)" srcset=".github/assets/afora-banner-dark.png">
       <img alt="afora — Model the domain. Keep the invariants." src=".github/assets/afora-banner-light.png" width="100%">
     </picture>
   </p>
   ```

   Keep the badges and the text below it unchanged.
3. **Package READMEs.** Do the same in `packages/*/README.md` only if they already have a header image. Do not add one where there is none.
4. **Social preview (manual, for a maintainer).** This cannot be set from a PR. Go to **Settings → General → Social preview → Edit → Upload an image** and upload `deliverables/github-settings/afora-social-preview.jpg`. Mention it in the PR description so a maintainer does it.
5. **Organization avatar (manual, for an owner).** Upload `deliverables/github-settings/afora-org-avatar.png` in the organization settings (Profile picture). There is no API for it.
6. **Organization profile.** If `afora-framework/.github` has a `profile/README.md`, use the same `<picture>` banner there, with absolute raw URLs to the files in `core`.
7. **Check:** open the README on GitHub in both light and dark themes. The banner switches, has no white edges and keeps its 4:1 ratio on mobile.

## Done when
- [ ] The README shows the light banner in the light theme and the dark one in the dark theme.
- [ ] The symbol SVGs are in `.github/assets/brand/`.
- [ ] A maintainer has uploaded the social preview and the organization avatar.
