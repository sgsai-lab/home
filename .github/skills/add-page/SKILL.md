---
name: add-page
description: "Add a new website page or route to the SGS AI site. Use when: creating a new page, adding a route under public/, adding a marketing/legal page, adding a signed-in account page, updating nav, sitemap, analytics paths, or Lighthouse URLs for a page."
argument-hint: "Route name and whether it is public or signed-in"
---

# Add a page

Pages are static folders: `/foo/` is served from `public/foo/index.html` (Nginx also resolves `/foo` and `/foo.html`). No router or build allowlist to update.

## Procedure

1. Pick a kebab-case route, e.g. `case-studies`. Check `public/<route>/` does not exist.
2. Copy the right template to `public/<route>/index.html` and replace every `ROUTE`, `PAGE_*` placeholder:
   - Public/marketing page: [public-page.html](./assets/public-page.html)
   - Signed-in/account page: [account-page.html](./assets/account-page.html)
3. Page-specific styles: create `public/<route>/<route>-page.css` (public pages) or extend `/assets/css/account.css` (account pages). Reuse `global.css` classes first: `section-wrap`, `section-kicker`, `gradient-text`, `button button-primary`, `button button-secondary`.
4. Page script, if needed:
   - Public page: classic script in `public/assets/js/<name>.js`, loaded with `defer`.
   - Account page: ES module in `public/assets/js/<route>.js`. Start from the pattern in `public/assets/js/projects.js`: `import { api, describeError, requireUser, handleSubmit, showStatus, h } from '/assets/js/auth.js';`, then wrap logic in `async function main() { const user = await requireUser(); ... }` and end with `main().catch((error) => showStatus(document.getElementById('page-status'), describeError(error)));`. No top-level `await`: `npm run build` (terser) fails on it.
5. Wire it up (public pages only, skip what does not apply):
   - Navigation: add `<a href="/<route>">` to `public/components/nav/nav.html`, then bump the `?v=7` fragment version in `public/assets/js/app.js`.
   - Footer links: `public/components/footer/footer.html`.
   - SEO: add a `<url>` to `public/sitemap.xml`.
   - Analytics: add `'/<route>/'` to `ANALYTICS_PATHS` in `src/server/server.mjs`.
   - Quality budget: add `http://127.0.0.1:4173/<route>/` to `lighthouserc.json`.
   - Account pages instead get `<meta name="robots" content="noindex">` and stay out of the sitemap.
6. Verify (see the verify-and-ship skill): `npm run lint && npm test && npm run build && npm run check:dist`, then open `npm run preview` at `http://127.0.0.1:4173/<route>/` and check header, nav, footer, mobile width, and keyboard focus.

## Rules

- Do not add Google Fonts, cdnjs, Plausible, or other third-party origins to new pages; the production CSP in `config/nginx.conf` blocks them.
- Keep exactly one `<h1>` and the skip link pointing to `#main`.
- Never render API data with `innerHTML`; use `h()` or `textContent`.
