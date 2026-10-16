# Manual checks with real models

The automated suite uses a fake engine. These steps check Local Arena against real models and a real graphics card. `python tools/real_check.py` sends one short chat through the running app to the loaded model and prints PASS or FAIL.

1. Open each screen and check controls, errors and overflow at 1440, 1280 and 1024 pixels.
2. Send, inspect reasoning, stop and retry in Chat. Check speed and context.
3. Switch chats, edit system prompts and reload. Check each chat retains its own messages and prompt.
4. Exercise rename, pin, duplicate, export, message deletion and chat deletion with Undo.
5. Add a GGUF and runtime, load and unload. Confirm disconnecting external servers leaves them running.
6. Check saved reply settings in Chat, Arena and Tests. Reload the same context profile after load changes.
7. Compare two real models in Arena, verify each answers, vote, undo and resume after navigation.
8. Run a small Test selection and custom questions, with and without expected answers. Check full saved answers.
9. Reload saved runs and votes, compare results and export CSV.
10. Restart the gateway with an owned engine running, then unload. Confirm no owned engine remains and independent servers stay up.
