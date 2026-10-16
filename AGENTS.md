# Local Arena

A local web app for chatting with, comparing and testing local language models. No build step: `server.py` (Python standard library) serves `app/` (plain ES modules). See README.md and docs/ARCHITECTURE.md.

- Test with `python tools/verify.py`, or one browser check with `node tools/ui_check.mjs --only <name>`. Tests use a fake engine and never need a GPU or a model. Details: docs/TESTING.md.
- If Local Arena is already running on this PC, set `ARENA_PORT_OFFSET=100` (or 200 ... 900) so the tests use other ports.
- Personal settings and saved data live in git-ignored files (`config/models.json`, `config/launcher.local.json`, `data/`). Do not commit them.
- Keep the source and licence fields on benchmark questions (see THIRD_PARTY_NOTICES.md).
