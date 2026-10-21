# Changelog

## Unreleased

- Added: side chats. When the loaded model's engine can write more than one reply at once, a button in the Chat header opens another chat beside the main one. Each has its own conversation, and both answer at the same time. The "Send to Arena" header button is gone; it is still in each chat's right-click menu.
- Fixed: the live tok/s meter read low for the whole first reply of a session on code-heavy answers. The correction the app learns from each finished reply is now saved per model, so a new session starts with it.
- Fixed: after a short reply, the Chat speed peak and graph could read lower than the reply's own speed.
- Fixed: a load whose launch script stopped without starting the model (for example, when a game held the graphics memory) waited 10 minutes at 95% before failing. It now fails after 90 seconds and says why.

## 0.1.0

First public release.

- Chat with streamed reasoning, Markdown, live speed and graphics-memory readings, saved conversations and per-chat settings.
- Arena: blind side-by-side comparisons of two models or two sets of instructions, with votes saved.
- Tests: graded runs on 704 questions from public benchmarks, plus your own questions, with saved runs and CSV export.
- Models: find GGUF files on your PC, load and unload them, connect a server that is already running, and keep reply and load settings per model.
- Local Arena stops only the model servers it started itself.
