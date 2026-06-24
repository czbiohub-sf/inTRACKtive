> # This PR will not be reviewed until the Summary, Related Issues, and Pre-Review Checklist sections are completed.
>
> # DO NOT DELETE THESE SECTIONS.
>
> ## PRs will be considered drafts until all sections are filled.

## Summary

<!-- What does this PR do and why? 1-3 sentences. -->

## Related Issues

<!-- Link issues: Fixes #123, Relates to #456 -->

## Pre-Review Checklist

### Self-Review and Cleanup

- [ ] I performed at least one round of self-review on the complete diff (reading my own changes as if I were the reviewer). This can be a manual review or an AI-assisted review.
- [ ] I performed at least one round of code refactoring/cleanup (e.g. consolidated duplicated code, removed unused code, simplified complex sections, improved readability).
- [ ] I removed all debugging artifacts (console.log, print statements, commented-out code, temporary workarounds).
- [ ] The diff contains only intentional changes - no accidental file inclusions, unrelated formatting, or stray whitespace edits.

### Correctness

- [ ] I tested this locally and verified the happy path works
- [ ] I tested relevant edge cases and error conditions
- [ ] I verified there are no regressions in existing functionality

### Code Quality

- [ ] All imports resolve to real modules in this project or its declared dependencies
- [ ] No dead error handling - every catch/fallback addresses a condition that can actually occur
- [ ] Naming and patterns are consistent with the surrounding codebase
- [ ] No unused variables, functions, or files introduced by this PR

### Security

- [ ] User input is sanitized or parameterized before reaching databases, shell commands, or HTML output - no raw string interpolation (e.g. use parameterized queries instead of `f"SELECT * FROM users WHERE id = {input}"`, use `shlex.quote()` or argument lists instead of `f"cmd {input}"`, escape or use safe rendering instead of injecting into HTML)
- [ ] No hardcoded secrets (API keys, passwords, tokens, credentials) anywhere in the diff
- [ ] Sensitive environment variables have no fallback values - a missing secret must fail explicitly, not fall back to a default (e.g. `process.env.API_KEY!` not `process.env.API_KEY || 'sk-...'`)
- [ ] No `.env` files, credential files, or private keys are included in the diff
- [ ] New secrets or configuration are documented (e.g. added to `.env.example` or deployment docs)

### Hygiene

- [ ] Branch is up to date with the target branch
- [ ] No merge conflicts
- [ ] Linting and formatting pass
- [ ] CI is green (or failures are unrelated and noted below)

### Testing

How is this PR tested? Check all that apply.

- [ ] New unit tests added
- [ ] New integration/e2e tests added
- [ ] Existing tests cover the changes
- [ ] Manual testing only (explain why automated tests aren't feasible)
- [ ] No tests needed (explain why - e.g., config-only change, documentation)

## Notifications

- If **Leandro** is a reviewer, please notify him in Slack - he will likely miss the GitHub email notification.

## Additional Notes

<!-- Anything else reviewers should know? Screenshots, deployment notes, open questions, etc. -->
