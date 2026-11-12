# Agents guide

<!-- Always loaded. Every line must change what an agent does; push the rest behind a pointer in
"Before you…". When a change makes a line wrong, rewrite or remove it. -->

Selects is a self-hosted app that posts a photographer's backlog to Instagram on a schedule,
each photo rendered on a frame with its EXIF data. No application code exists yet.
[docs/PRODUCT.md](docs/PRODUCT.md) holds the brief and every settled decision.

## Public repository

Every commit, PR, issue, comment, log and screenshot here is public and permanent: treat each
one as published.

- Secrets live only in runtime environment variables, read through one config module that names
  a missing variable without printing its value. `.env.example`, with names and placeholder
  values, is the only env file in git.
- Client-visible variables (`VITE_`) carry public identifiers only.
- Redact values from everything you post or commit: logs, errors, snapshots, PR text,
  screenshots. When a secret is needed, ask the developer to set it in the environment.
- Scan each diff for secrets before committing. A leaked secret is burned: rotate it first,
  then remove it.
- Keep docs machine-agnostic: refer to env variables and scripts in place of hostnames, ports,
  home paths and internal URLs.
- Chat stays in chat. Code, commits, PRs, issues and docs carry the product and the code only:
  leave out what was said in conversation and any name or personal detail from it.
- Photos in git are generated fixtures. Real photographs, their file names and their
  coordinates stay in the git-ignored `data/`.

## Before you…

- **add a dependency, font or outside code**: check its license against
  [ADR 0001](docs/adr/0001-mit-license.md).
- **build UI**: read [brand/tokens/README.md](brand/tokens/README.md). `brand/tokens/selects.css`
  is the only source of colors and radius.
- **touch a brand asset**: read [brand/README.md](brand/README.md).
- **decide** anything about the product or architecture: read [docs/PRODUCT.md](docs/PRODUCT.md)
  and `docs/adr/`, then record the decision as the next numbered ADR.
- **call Instagram or the bucket**: read [ADR 0003](docs/adr/0003-instagram-publishing.md).
  Development and tests run against the fake Instagram server.
- **open, push to or land a PR, or push docs to `main`**: read
  [docs/agents/pull-requests.md](docs/agents/pull-requests.md).

## Agent skills

### Issue tracker

GitHub Issues in `brandonnly/selects`, through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` at the root and `docs/adr/`. See `docs/agents/domain.md`.
