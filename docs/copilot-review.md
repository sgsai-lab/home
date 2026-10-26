# Automatic Copilot PR review

The [PR Reviewer agent](../.github/agents/pr-reviewer.agent.md) runs through
the `review` and `publish-review` jobs of the
[Website CI](../.github/workflows/ci.yml) workflow on opened, updated,
reopened, and ready-for-review pull requests.

## Enable it

1. Use a GitHub account with an active Copilot subscription, CLI access, and any
   required organization policy approval.
2. Create a **fine-grained personal access token** with the **Copilot Requests**
   account permission. Do not grant repository write access to this token.
3. Add it under repository **Settings > Secrets and variables > Actions** as
   `COPILOT_GITHUB_TOKEN`. Never put the value in source code, comments, or logs.
4. Merge the agent, the shared `.github/actions/setup` action, and the workflow
   into the PR target branch. The workflow loads its agent, setup action, and
   repository guide from the PR merge commit, so the review also runs on the PR
   that introduces them.
5. Open or update a non-draft PR from a branch in this repository. Look for the
   **review** job in the **Website CI** Actions run and its bot comment.

This repository currently has a personal-account owner, so the workflow uses a
PAT rather than organization-billed Copilot `GITHUB_TOKEN` authentication.
The normal Actions token publishes the comment; it is not the Copilot token.
Copilot usage is billed against the token owner's plan and limits. Rotate the
secret before its token expires. Missing/expired tokens or exhausted usage fail
the workflow visibly instead of producing a successful-looking review.

## Behavior and safeguards

- Fork PRs, drafts, and Dependabot-triggered runs are skipped. Review those
  changes manually; do not switch to `pull_request_target` to expose the secret.
- The review job has only `contents: read` and `pull-requests: read`; a separate
  publishing job has `pull-requests: write` and `issues: write` and never
  receives the Copilot secret.
- The checkout does not persist credentials. PR code is retrieved as diff text
  for the prompt and is never installed, built, or executed; the only install is
  the pinned Copilot CLI from the npm registry. Agent and setup configuration
  come from the PR merge commit: because same-repo pull requests already control
  this workflow file, reading them from the base branch would add no protection.
- Copilot runs in an isolated temporary directory with a fresh configuration
  directory, no tools, no built-in MCP servers, and no implicit custom
  instructions or repository hooks copied from the checkout.
- The agent receives the repository guide and the entire diff.
  Diffs over 60,000 UTF-8 bytes or prompts over 100,000 bytes fail explicitly;
  input is never silently truncated. Split oversized PRs or review them manually.
- One marked bot comment is created and updated, with the reviewed commit SHA.
  Concurrent runs are cancelled, and a changed, closed, or draft PR is checked
  again before publishing so known-stale reviews are not posted.
- Output must include Findings, Verification, and Limitations sections. Each
  finding is a `### <Severity>: <path>:<line>` block with a scenario, impact,
  and a fenced code snippet for the fix; `<line>` is the exact new-side line
  number. Empty, malformed, or oversized reviews fail rather than being posted
  as a clean bill of health. Findings are advisory, not an approval or a
  branch-protection gate.
- Critical, High, and Medium findings also open one tracking issue per PR,
  assigned to the PR author, titled `Copilot review findings for PR #<n>`. The
  issue body (locations, findings, and fixes) is refreshed on each reviewed
  push, and the issue is closed automatically with a comment when a later
  review has no remaining Critical/High/Medium findings. Low findings appear
  only in the PR comment. Findings whose heading does not match the format are
  skipped with a workflow warning.
- This is a diff-only AI review, not GitHub's native Copilot code review.
  Unchanged source, binary content, and runtime behavior are not independently
  inspected. Existing CI and human review remain necessary.

You can also select **PR Reviewer** in Copilot's custom-agent picker and supply a
diff manually. It intentionally has no tools in either mode.

## Maintenance and verification

The CLI version and action commit SHAs are pinned in the workflow and the
shared setup action. The CLI install is cached by runner OS/arch and version
through the `copilot-cli-version` input, so bumping `COPILOT_CLI_VERSION` in
the workflow `env` updates both the cache key and the install. Update
deliberately and verify CLI flags before upgrading: the workflow parses the
CLI's `--output-format json` event stream (`assistant.message` content and the
`result` exit code) because the default text output renders Markdown for a
terminal and strips the required headings. Agent changes take effect
on the PR that makes them and on every PR after they reach the target branch.

Validate the workflow with `actionlint .github/workflows/ci.yml`
and run the standard repository checks from [AGENTS.md](../AGENTS.md). A full
end-to-end check requires the secret and a real PR: confirm that a new push
updates the same comment, draft/fork runs are skipped, and authentication
failures leave a failed Actions run. No local test can establish that the
repository secret or Copilot billing is configured correctly.

To disable automation, remove the `review` and `publish-review` jobs from
**Website CI**.
Removing the token alone intentionally causes eligible review runs to fail.

References:

- [Copilot CLI in Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions)
- [Programmatic CLI options](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [Custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
