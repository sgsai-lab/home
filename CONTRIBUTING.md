# Contributing

## Development

Use a supported Node.js LTS release and npm. Run `npm ci`, then use `npm run lint`, `npm test`, and `npm run build` before opening a pull request. Contact form email delivery requires the server-side SMTP environment documented in README.md; never add credentials to source, HTML, or client JavaScript.

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