# Repository conventions

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

## Commits

Use `type: short description` in English, with a lowercase type and an imperative
description: `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore`.

Keep each commit focused on one logical change, including its relevant tests and
documentation. Split unrelated changes into separate commits.
