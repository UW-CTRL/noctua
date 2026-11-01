# Repository conventions

Write all changes in English.

Use [Lucide](https://lucide.dev/icons/) as the reference for icons.

Before editing a folder, read its applicable `AGENTS.md` files for local rules
and file inventories; do not load unrelated inventories.

Keep implementation, relevant validation, and user documentation in sync in the
same change. For note or chat-rendering changes, read and follow
[Feature synchronization](docs/development.md#feature-synchronization) before editing.

Keep shared prompts focused on common behavioral rules and domain syntax; do not duplicate tool schemas, descriptions, arguments, response formats, or limits.

Keep the project README focused on the overview, downloads, and guide links.
Find guide responsibilities in [docs/AGENTS.md](docs/AGENTS.md) and prompt
responsibilities in [src/prompts/AGENTS.md](src/prompts/AGENTS.md).

## Issues and pull requests

Use the compact Bug report, Feature request, or Task issue template and set
GitHub's Issue type to `Bug`, `Feature`, or `Task`, respectively. Free-form issues
should also have an Issue type. Do not duplicate types with labels. Add at least
one `area:*` label from the [area map](docs/development.md#issue-labels), based on
the affected feature; use multiple areas for cross-feature work.

Resolve issues through linked pull requests. Include `Closes #123` in the PR body
for each fully resolved issue; use `Refs #123` for partial work. Keep issues open
until the resolving PR is merged.

## Commits

Use `type: short description` in English, with a lowercase type and an imperative
description: `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore`.

Keep each commit focused on one logical change, including its relevant tests and
documentation. Split unrelated changes into separate commits.
