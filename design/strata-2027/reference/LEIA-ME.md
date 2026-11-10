# Capas do afora — Strata Matéria

## GitHub social preview (1280×640)
`github/afora-social-preview.jpg` (escuro) ou `github/afora-social-preview-light.jpg` (claro). Os dois têm menos de 1 MB, o limite do GitHub.
Para enviar: no repositório, abra **Settings → General → Social preview → Edit → Upload an image**.

## Banner do README (1280×320, salvo em 2× = 2560×640)
Copie `readme/` para `.github/assets/` no repositório e cole no topo do README.md:

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/afora-banner-dark.png">
    <img alt="afora — Model the domain. Keep the invariants." src=".github/assets/afora-banner-light.png" width="100%">
  </picture>
</p>
```

O GitHub mostra o banner escuro para quem usa o tema escuro.

## OpenGraph (1200×630)
`opengraph/og.jpg` (EN), `opengraph/og-pt-BR.jpg` (PT) e `opengraph/og-dark.jpg` (versão escura, opcional). Publique em `https://getafora.com/` e use no `<head>`:

```html
<meta property="og:image" content="https://getafora.com/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="afora — Model the domain. Keep the invariants.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://getafora.com/og.jpg">
```

Na versão em português, troque `og.jpg` por `og-pt-BR.jpg` e use o alt "afora — Modele o domínio. Mantenha as invariantes.".
