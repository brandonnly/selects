# Pull requests and landing

How a change reaches `main`.

## When to open a PR

Iterate on a branch named `<issue-number>-<short-slug>`, cut from a fresh `origin/main`, and show
each change. Open the PR, which starts the review bots, once the developer approves the logic
and UI.

## Where a change lands

- **Code** goes through a pull request and lands as a squash merge.
- **Docs that later work starts from** go straight to `main`: plans, ADRs, the glossary,
  `docs/PRODUCT.md`, and agent instructions that come with no code change. Commit on a fresh
  `origin/main` as `docs(<scope>): ...` and `git push origin HEAD:main`. On a rejected push,
  `git fetch`, rebase the commit onto `origin/main`, and push again.
- **Docs that describe behaviour** (READMEs, UI copy, an `AGENTS.md` line about a command) land in
  the PR that changes the behaviour, so `main` describes only code it has.

## Titles and bodies

- Title: `<type>(<scope>): <subject>` with the narrowest accurate scope (`server`, `web`,
  `gallery`, `brand`, `repo`). `docs` is a type, not a scope. The title becomes the squash commit
  subject.
- Body: write it with the `pr` skill. Put `Closes #<n>` before each issue the PR finishes and
  `Part of #<n>` before a parent spec, so landing closes exactly the finished issues.

## Evidence

A UI change shows before and after screenshots, and a change to the frame shows a rendered frame.
Open the PR first (a draft is fine), then upload them with `pr-media` (the `pr-media` skill has
the steps) and put the markdown it prints in the body. Evidence is public: render it from the
generated fixtures, never from a real photograph.

## Landing

A PR lands when its checks are green, every review bot comment has a fix or a one-line reason,
and the developer has approved it. Squash-merge and delete the branch:
`gh pr merge <n> --squash --delete-branch`.
