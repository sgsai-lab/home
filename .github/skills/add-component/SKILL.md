---
name: add-component
description: "Add or change a shared component (header, nav, footer, floating) or homepage section loaded dynamically by app.js. Use when: creating a reusable fragment, adding a homepage section, editing nav/footer/header markup, fragment CSS/JS, or cache-busting component changes."
argument-hint: "Component or section name and where it should appear"
---

# Add a component or section

`public/assets/js/app.js` holds a `components` array. For each entry whose mount `id` exists on the page, it fetches `/<path>.html?v=7`, injects it, then appends `/<path>.css?v=7` and `/<path>.js?v=7` when `hasCss`/`hasJs` is true. The header loads first (the nav mount lives inside it); the rest load in parallel. `scripts/check-links.mjs` parses this array, so keep its exact shape.

## Procedure

1. Choose the folder:
   - Reused across pages: `public/components/<name>/`
   - Homepage-only section: `public/sections/<name>/`
2. Create `<name>.html` (a fragment: no `<html>`, `<head>`, or `<body>`), plus `<name>.css` and `<name>.js` only if needed. Scope CSS under a component-specific class.
3. Register it in the `components` array in `public/assets/js/app.js`, keeping the one-line object format the link checker expects:
   ```js
   { id: '<name>-mount', path: 'sections/<name>/<name>', hasCss: true, hasJs: false },
   ```
   Order matters only for the header (index 0).
4. Add `<div id="<name>-mount"></div>` where it should render, e.g. in `public/index.html` for sections.
5. Component script: it runs right after injection, so query its own markup at top level (see `public/sections/contact/contact.js`). Do not wait for `DOMContentLoaded`. Guard against missing elements.
6. Cache-busting: whenever a fragment's HTML/CSS/JS changes, bump `v=7` → `v=8` in `app.js` (all three URLs) and in the `global.css`/`app.js` links across `public/**/*.html`, so returning visitors do not mix old and new files. Search for `?v=7` to update them together.
7. Verify: `npm run lint` (link check confirms each declared `.html/.css/.js` exists), `npm run build && npm run check:dist`, then preview every page that has the mount at desktop and mobile width.

## Rules

- In-page anchors to section IDs work because `app.js` scrolls after components load; legacy hashes (`#products`, `#vision`, `#about`, `#roadmap`, `#approach`) redirect to pages via `hashMapping`.
- No third-party assets (CSP). Images go in `public/assets/images/` and are referenced root-relative.
