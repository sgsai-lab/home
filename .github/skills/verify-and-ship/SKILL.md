---
name: verify-and-ship
description: "Validate, commit, and open a pull request for changes in the SGS AI site. Use when: finishing a feature or fix, running lint/tests/build/link checks, Lighthouse, Docker container smoke test, checking Cloud Run readiness, writing a commit message, or creating a PR to main."
argument-hint: "Optional: scope of the change (frontend, api, packaging)"
---

# Verify and ship

## 1. Pick checks by what changed

| Change touches | Run |
| --- | --- |
| Anything | `npm run lint && npm test && npm run build && npm run check:dist` |
| Pages, CSS, layout, nav | Above + `npm run preview` → check `http://127.0.0.1:4173` at desktop and ~375px width, keyboard Tab order, focus rings; `npm run lighthouse` for public pages |
| API, `config/nginx.conf`, `Dockerfile`, `scripts/build.mjs`, CSP, third-party resources | Above + `docker build -t sgs-ai-website:local . && bash scripts/check-container.sh sgs-ai-website:local` |
| Terraform, workflows | Review only; explain the plan in the PR. Never run `terraform apply` or touch local state without explicit approval. |

Fix failures at the root cause; do not loosen lint rules, skip tests, or delete checks to get green. If a check cannot run locally (no Docker/Chrome), say so in the PR.

## 2. Self-review

- `git status --short` and `git diff`: only intended files. No `dist/`, `.lighthouseci/`, `node_modules/`, `.env`, Terraform state/plan/tfvars.
- `git diff --check` for whitespace errors.
- No secrets, tokens, or personal data in code, tests, or logs.
- Docs updated when behavior, commands, or structure changed: `README.md`, `docs/*.md`, `AGENTS.md`, and the relevant skill.

## 3. Commit

- Work on a branch, never directly on `main`: `features/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Conventional Commit subject, imperative, ≤ 72 chars: `feat(projects): add project archive endpoint`.
- One logical change per commit; each commit should pass the checks above.

## 4. Pull request

Push with `git push -u origin <branch>`, then open a PR against `main` (`gh pr create --base main`) using `.github/pull_request_template.md`:

- **Summary**: what changed and why.
- **Verification**: tick only checks actually run, with results (e.g. "11 tests pass"). Leave manual checks unticked if not done.
- **Notes**: risks, CSP/runtime config changes, required GitHub variables or Secret Manager updates, rollback.

Merging to `main` triggers the production deploy workflow; do not merge or deploy without the user's approval.
