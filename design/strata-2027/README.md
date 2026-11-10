# New brand in the repository: README banner, social preview and symbol

**Labels:** `documentation`, `design`, `good for agents`

## Context
The project has a new visual identity, **Strata Matéria**. The symbol keeps its seed silhouette, now filled with a sediment gradient: ocre on top, terracotta in the middle, moss and lagoon at the bottom, with the cursor line in ink. This issue brings it into `afora-framework/core`.

- **The canvas with every board** is https://claude.ai/artifact/6giWdjx9muxmwVVLdJTZuA (`Brand2027`, `Banner2027`, `Banner2027Dark`, `Social2027`, `OpenGraph2027`).
- **The site and admin changes** have their own issues in `website` and `cms`.

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
1. **Add the files.** Copy `assets/afora-banner-light.png` and `assets/afora-banner-dark.png` to `.github/assets/`, and the two `shared/afora-symbol-fluid-*.svg` to `.github/assets/brand/`.
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
4. **Social preview (manual, for a maintainer).** This cannot be set from a PR. Go to **Settings → General → Social preview → Edit → Upload an image** and upload `assets/afora-social-preview.jpg`.
5. **Organization profile.** If `afora-framework/.github` has a `profile/README.md`, use the same `<picture>` banner there, with absolute raw URLs to the files in `core`.
6. **Check:** open the README on GitHub in both light and dark themes. The banner switches, has no white edges and keeps its 4:1 ratio on mobile.

## Done when
- [ ] The README shows the light banner in the light theme and the dark one in the dark theme.
- [ ] The symbol SVGs are in `.github/assets/brand/`.
- [ ] A maintainer has uploaded the social preview.
