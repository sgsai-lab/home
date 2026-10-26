---
description: "Use when editing website pages, components, sections, browser JavaScript, or CSS under public/."
applyTo: "public/**"
---

# Frontend conventions

- Everything under `public/` is deployed as-is (minified). Never put secrets, server code, or private notes here.
- Use root-relative URLs (`/assets/css/global.css`, `/assets/js/auth.js`). Preserve existing public URLs.
- Every page keeps `<a href="#main" class="skip-link">`, `#header-mount`, `#nav-mount`, `<main id="main">`, and `#footer-mount`, and loads `/assets/css/global.css?v=7` and `/assets/js/app.js?v=7` (defer).
- Reuse `global.css` tokens and classes (`section-wrap`, `section-kicker`, `button button-primary`, `gradient-text`) before adding CSS. Page-only CSS goes in `public/<route>/<route>-page.css`.
- Account/signed-in pages: add `<meta name="robots" content="noindex">`, `/assets/css/account.css`, and a `type="module"` script that imports helpers from `/assets/js/auth.js` (`api`, `requireUser`, `handleSubmit`, `showStatus`, `h`). Build DOM with `h()`/`textContent`, never `innerHTML` with user or API data.
- No top-level `await` in browser JS: the build minifier rejects it. Wrap in `async function main()` and call `main().catch(...)` like `projects.js`.
- Do not add third-party scripts, styles, or fonts: the production CSP in `config/nginx.conf` blocks them.
- Changing a component/section fragment: bump `?v=7` in `public/assets/js/app.js` and the page links together.
- Validate with `npm run lint` (ESLint, Stylelint, html-validate, link check).
