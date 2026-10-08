# SGS AI Technology — System Specification

## 1. Overview
The website is a modular, single-page application (SPA) that avoids frameworks (React/Vue/etc.) while keeping the codebase highly maintainable. The UI and UX remain exactly as originally designed.

## 2. Architecture & File Structure
The project is divided into global configuration, modular components, and sections. `index.html` acts as the root composer that mounts each piece dynamically.

```text
/
├── index.html            (Root composer & mount points)
├── 404.html              (Fallback for invalid URLs)
├── nginx.conf            (Web server config for single-page routing)
├── systemspecification.md(This document)
├── global.css            (CSS variables, typography, reset)
├── app.js                (Core loader for HTML/CSS/JS modules)
│
├── components/
│   ├── header/           (Logo & brand container)
│   │   ├── header.html
│   │   ├── header.css
│   │   └── header.js
│   ├── nav/              (Desktop & Mobile navigation, hamburger logic)
│   │   ├── nav.html
│   │   ├── nav.css
│   │   └── nav.js
│   └── footer/           (Bottom navigation & copyright)
│       ├── footer.html
│       ├── footer.css
│       └── footer.js
│
├── sections/
│   ├── hero/             (Hero section with network animation)
│   ├── vision/           (Vision & Approach section - #vision)
│   ├── products/         (Services & Offerings - #products)
│   ├── roadmap/          (Future plans timeline - #roadmap)
│   ├── about/            (Company story & Quote - #about)
│   └── contact/          (Contact form & info - #contact)
│
└── assets/               (Global static assets)
    ├── fonts/
    ├── images/
    └── logo/
```
*(Note: Every folder in `sections/` contains its respective `.html`, `.css`, and `.js` files)*

## 3. Dynamic Loading Mechanism (`app.js`)
Since no frameworks are used, `index.html` relies on a lightweight Vanilla JS loader (`app.js`).

**Loading Order Guarantee:**
1. Fetch `section.html` via `fetch()`.
2. Inject into the designated container (e.g., `<div id="hero-mount">`).
3. Append `<link rel="stylesheet" href="...section.css">` to `<head>`.
4. Append `<script src="...section.js">` to the DOM.
5. Initialize the section logic (if the script exports an `init()` function or self-executes).

## 4. CSS Strategy
- **Global (`global.css`)**: Contains CSS variables (`:root`), base resets, global typography (`body`, `h1`-`h6`, `p`), and shared utility classes (like `.section-wrap`, `.button`).
- **Modular (`*.css`)**: Each component/section CSS file is strictly scoped to its own class names (e.g., `.hero-copy`, `.service-grid`) to prevent leaks.

## 5. JavaScript Strategy
- **`app.js`**: Core loader and legacy anchor backwards compatibility (`#services` -> `#products`).
- **`nav.js`**: Implements `IntersectionObserver` to highlight active nav links on scroll, handles smooth scrolling, and manages the mobile hamburger menu state.
- **Section JS**: Scripts like `hero.js` are responsible *only* for the complex visual animations in the hero area.

## 6. Nginx & SEO Configuration
- The site remains a Single-Page Application (SPA).
- `nginx.conf` directs all root traffic to `/index.html`.
- Unknown paths (e.g., `/random-page`) will serve a `404` status code and return `404.html`.
- All SEO `<meta>` tags, descriptions, and Open Graph configurations are preserved natively inside the `<head>` of `index.html`.

## 7. Migration Mapping (Legacy Anchors)
To ensure old links do not break, `app.js` will intercept incoming hashes and redirect accordingly:
- `#services` → `#products`
- `#approach` → `#vision`
- `#about` → `#about`
- `#contact` → `#contact`
