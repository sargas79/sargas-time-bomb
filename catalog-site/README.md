# Sargas Foundry Catalog

A static GitHub Pages site listing every Foundry VTT module and game system
published by [sargas79](https://github.com/sargas79), with each one's name,
manifest URL, one-line description and latest released version.

## How it works

- `catalog.config.json` lists the repositories to include and a one-line
  summary for each. Add a new module or system by adding an entry there.
- `scripts/update-catalog.mjs` fetches the latest released manifest of every
  repository (`releases/latest/download/module.json` or `system.json`) and
  writes `data.json`.
- `index.html` renders `data.json`.
- The `pages.yml` workflow refreshes `data.json` on every push to `main`,
  once a day, and on demand, then deploys the site to GitHub Pages.

## Publishing

1. Push this folder to the `main` branch of a public repository.
2. In the repository settings open **Pages** and set **Source** to
   **GitHub Actions**.
3. The workflow runs on the next push (or via **Actions → Build and deploy
   catalog → Run workflow**). The site is served at
   `https://<owner>.github.io/<repo>/`.

## Refreshing locally

```
node scripts/update-catalog.mjs
```
