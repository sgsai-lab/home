# Contributing

## Development

Use Node.js 22 (see [.nvmrc](.nvmrc)) and npm. Run `npm ci`, then use `npm run lint`, `npm test`, `npm run build`, and `npm run check:dist` before opening a pull request. Contact form email delivery requires the server-side SMTP environment documented in [README.md](README.md); never add credentials to source, HTML, or client JavaScript.

## Code and folder conventions

- Keep browser-delivered files in `public/`, Node-only modules in `src/server/`, automation in `scripts/`, and tests in `test/`. Nothing private belongs in `public/`; its entire contents are deployed.
- Put shared browser scripts/styles in `public/assets/js/` and `public/assets/css/`. Keep page-specific styles beside their page and component/section HTML, CSS, and JavaScript together.
- Preserve page routes and update every HTML reference, JavaScript import, and CSS URL when moving a resource. Keep third-party browser code isolated in `public/vendor/` and preserve its attribution.
- Follow [.editorconfig](.editorconfig): UTF-8, LF, two-space indentation, and a final newline. Use descriptive camelCase identifiers, PascalCase classes, and kebab-case names for new files. Preserve established public names unless a migration requires changing them.
- Use ES modules, `const` by default, strict equality, and explicit error handling. Keep functions focused and follow the checked-in ESLint, Stylelint, and HTML validation rules. Do not mix unrelated formatting changes with behavior changes.
- Validate untrusted input at the server boundary. Keep runtime secrets in the environment or Secret Manager, never browser configuration or source control.
- Add focused `node:test` regression coverage for behavior changes. Use injected dependencies or in-memory persistence in tests; do not require live SMTP, cloud credentials, or production data.
- Keep dependencies and lockfile changes intentional. Do not commit `dist/`, `node_modules/`, Lighthouse reports, Terraform state/plans, or local configuration containing secrets.

When changing packaging or routing, run `npm run lighthouse`, `docker build -t sgs-ai-website:local .`, and `bash scripts/check-container.sh sgs-ai-website:local`. The Cloud Run smoke test verifies the production container, not just the static preview. See [docs/architecture.md](docs/architecture.md) for module boundaries and [docs/deployment.md](docs/deployment.md) for operations.

## Branches

- Use short, descriptive branches: `features/<topic>`, `fix/<topic>`, `docs/<topic>`, or `chore/<topic>`.
- Branch from the repository's protected default branch and keep changes focused.
- Do not commit directly to the default branch.

## Commits

Use Conventional Commit-style subjects, for example `feat: add product roadmap` or `fix: validate contact submissions`. Keep the subject imperative, concise, and scoped to one change. Each commit should build and pass relevant checks.

## Pull requests

Explain the user-visible change and verification, include screenshots for visual changes, and call out operational configuration or privacy implications. CI must pass before merge. Do not include credentials, logs with personal data, or generated build output.

## Ownership and repository protections

The repository has no verified individual or team owner configured in CODEOWNERS yet. A repository administrator must add the correct GitHub team or users before code-owner review can be enforced. Branch protection, required reviews/checks, 2FA, secret scanning, push protection, Dependabot security updates, and production-environment reviewers are repository/organization settings; see README.md for the owner setup checklist. This repository configuration does not modify other repositories.