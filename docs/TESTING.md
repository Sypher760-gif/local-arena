# Testing

Test commands. Each prints PASS or FAIL per check and exits 0 only when everything passed.
Run them from the project root.

| Command | What it tests | Ports it uses |
|---|---|---|
| `python tools/test_gateway.py` | The gateway (`server.py`) against the fake engine, incl. the fake switcher | 8771, 8772, 8774 |
| `node tools/test_engine.mjs` | The browser engine client (`app/js/engine.js`), incl. live switching | 8771, 8773, 8774 |
| `node tools/test_markdown.mjs` | The markdown renderer (`app/js/markdown.js`), against a fake DOM | none |
| `node tools/test_questions_loader.mjs` | The Arena question bank loader (`app/js/questions.js`), with a stubbed `fetch` | none |
| `node tools/test_store.mjs` | The saved-data client (`app/js/store.js`) against the gateway, with a fresh temp store | 8783, 8784 |
| `python tools/test_add_models.py` | GGUF scan, validation, commands and model API | 8783, 8784 |
| `python tools/test_hard_bank.py` | Bank selection, sources and attribution | none |
| `python tools/test_model_settings.py` | Reply/load settings and script arguments, no engine | none |
| `python tools/test_models_list.py` | Portable catalogue fixtures and profile matching, no engine | none |
| `python tools/test_release_reliability.py` | Failed saves, warm-up exclusion, no-output cancellation, concurrent records and harmless owned child processes | 8771, 8772 |
| `node tools/test_engine_switch_race.mjs` | A finished switch reads fresh status after an older poll settles, stub fetch only | none |
| `node tools/test_engine_tuning.mjs` | Delayed/stale model settings and explicit zero values, stub fetch only | none |
| `node tools/test_grader.mjs` | Deterministic grading rules | none |
| `node tools/test_pace.mjs` | Question selection, budget and ETA math | none |
| `node tools/test_questions.mjs` | Active bank shape and source metadata | none |
| `node tools/ui_check.mjs` | The real app in headless Chrome, end to end | 8781, 8782, 9231 |

Never use 8790 (the live app) or 8080 (the real engine). The UI checks use the fake switcher only
(`ARENA_SWITCH_FAKE=1`): checks 50 and 51 start and stop `tools/fake_engine.py` on test ports, never a real model.

Set `ARENA_PORT_OFFSET=100` (or 200, up to 900) to move every test port up by that much. Use this when
another copy of Local Arena is running, so the tests do not land on its ports. The ports below are the
unshifted ones.

## UI checks: `tools/ui_check.mjs`

```
node tools/ui_check.mjs                  run every check in tools/ui_checks/
node tools/ui_check.mjs --list           print check names only
node tools/ui_check.mjs --only 10-chat-live
node tools/ui_check.mjs --keep           leave the servers and Chrome running, print their PIDs
```

What it does: starts the fake engine on 8781 (`--wps 60`), the gateway on 8782 (engine 8781, a fresh
temp store), and headless Chrome on 9231 (a fresh temp profile). Each check gets a new tab, an empty
`localStorage`, and a reset request log on the fake engine. A check fails when it throws, or when the
page logs an uncaught error or `console.error`, unless the check calls `t.allowErrors()`.

When the UI step fails, `tools/verify.py` prints one `  failed check: <name>: <first error line>` line per
failure, and `tools/ui_check.mjs` ends with `ui_check failed: <names>`; if the whole run failed (the 6
minute limit or a startup error) the check that was running last is named instead, so nobody has to
rerun everything to find it.

Limits: 90 s per check, 10 minutes for the whole run. On any exit path, including Ctrl+C, Chrome and both
servers are stopped. The temp folders (Chrome profile, store, logs) are removed in normal runs. After a
failed start, a Chrome profile folder can stay under the temp folder; delete it by hand. If a port is
already in use, the run stops before starting anything.

Output looks like this:

```
PASS 00-routes (0.4s)
PASS 10-chat-live (2.9s)
PASS 20-sim-mode (0.1s)
ui_check: 3 passed, 0 failed
```

## The helper object `t`

Each check file receives `t` in `run(t)`. Selectors are CSS selectors. Functions that take a selector
act on the first match, unless noted.

| Call | What it does |
|---|---|
| `await t.open(hash, query = "")` | Opens `http://127.0.0.1:8782/index.html<query>#/<hash>` and waits for the top bar and the route. |
| `await t.reload()` | Reloads the page and waits for the top bar. |
| `await t.eval(expr)` | Runs a JavaScript expression in the page. Awaits promises. Returns the value. |
| `await t.waitFor(expr, ms = 15000)` | Polls `expr` until it is truthy. Times out with the expression text in the message. |
| `await t.click(sel)` | Focuses and clicks the element. Throws if it is missing or disabled. |
| `await t.type(sel, text)` | Sets the value and fires `input`. For textarea and input. Also focuses it. |
| `await t.press(key)` | Sends a real key to the focused element. `"Enter"` or `"Escape"`. |
| `await t.text(sel)` | The element's `innerText`. Throws if missing. |
| `await t.exists(sel)` | `true` or `false`. |
| `await t.count(sel)` | Number of matches. |
| `await t.fakeRequests()` | Array of the last 50 chat request bodies sent to the fake engine, oldest first. |
| `await t.storeList(collection)` | Items from the gateway store (`/api/store/<collection>`). |
| `await t.storeGet(collection, id)` | One stored object. Throws on 404. |
| `await t.killEngine()` | Stops the fake engine. |
| `await t.startEngine(extraArgs = [])` | Starts the fake engine again, with extra command-line arguments. |
| `await t.screenshot(name)` | Saves `data/test-artifacts/shots/<name>.png` and returns the path. |
| `await t.setViewport(width, height = 900)` | Resizes the page viewport (CDP `Emulation.setDeviceMetricsOverride`) for layout checks. |
| `t.assert(condition, message)` | Throws `message` when `condition` is false. |
| `t.allowErrors()` | Lets this check pass even if the page logged errors. |

## Current UI checks

Run in number order. `00-routes` opens all four screens and fails on any page error.

| Check | What it proves |
|---|---|
| `00-routes` | All four screens open with the top bar and no page errors |
| `10-chat-live` | Chat sends to the fake engine, streams, shows speed and the model chip |
| `20-sim-mode` | `?sim=1` still runs the simulated engine |
| `30-chat-history` | A send carries the whole conversation, the system prompt and the settings |
| `31-chat-settings` | Settings are editable, sent to the engine, and survive a reload |
| `32-chat-actions` | Copy, Regenerate and Delete work on a message |
| `33-chat-engine-lost` | A lost engine turns the stuck reply into an error block and shows a banner that clears on restart |
| `34-chat-thinking-title` | Reasoning shows as a folded Thinking block, and a new chat is titled from its first message |
| `40-chat-saved` | A live chat is saved to the store, comes back after a reload, and New starts a second chat |
| `41-chat-manage` | Rename, Export and Delete on a chat row work and are reflected in the store |
| `42-arena-saved` | An Arena vote is saved, loads on open, and Undo removes it |
| `43-tests-saved` | A finished Test run is saved and loads on open |
| `44-settings-saved` | Chat settings are saved to the store and survive a reload |
| `50-models-switch` | Live Models lists the catalogue; Load shows the confirm, then the loaded light and top bar move to it; a not-on-disk entry has no Load button (fake switcher) |
| `51-switch-guards` | During a switch the top bar says "Loading", Chat Send is disabled and says "A model is loading"; after it finishes Send is enabled again (fake switcher) |
| `52-chat-accessible` | Every focusable element on Chat has a non-empty accessible name and takes keyboard focus in reading order |
| `53-plain-english` | With the engine killed, Chat, Models, Arena and Tests show plain sentences and no raw error text such as `undefined`, `NaN`, `[object`, `TypeError`, `Failed to fetch`, or `HTTP 5` |
| `54-models-states` | With the engine killed, Models still lists the model rows and the top bar says the engine is not answering |
| `55-arena-states` | With the engine killed and no saved votes, Arena says the engine is not answering, disables Start, and says no votes are saved |
| `56-tests-states` | With the engine killed and no saved runs, Tests says to load a model, says there are no runs yet, and shows the engine-not-answering state |
| `57-arena-phases` | In a live Arena round each side shows its own phase line ("Thinking" with three pulsing dots, then "Writing") and keeps a closed "Thought for" row holding the reasoning text after the round; both cards share the row at 1024 px wide (slow fake engine) |
| `60-arena-round` | A live Arena round streams both answers, keeps model names hidden until you vote, records the vote, and Undo reverses it (fake engine) |
| `61-tests-run` | A live Tests run finishes, shows the score table, and its CSV export is well formed: header, one row per type, 5 columns, plain numbers (fake engine) |
| `70-narrow-layout` | Chat, Models, Arena and Tests resize to 1280 and 1024 wide with no horizontal overflow (`scrollWidth <= innerWidth`) |
| `72-tokens-speed` | The Chat speed card unit reads "tokens per second", the Chat reply footer contains "tok/s" and not "words per second", and the Arena side readout unit is "tok/s" (fake engine) |
| `73-markdown` | A reply containing `[[markdown]]` makes the fake engine return bold, a list and a table; Chat and Arena show `strong`, `ul`/`ol` and `table`, and the literal `**` never appears (fake engine) |
| `74-work-phases` | A Chat reply shows a live phase line with three pulsing dots ("Thinking" while the model reasons, "Writing" once the answer starts), the thought row opens while thinking and folds shut on its own with a "Thought for" summary, clicking it reopens the reasoning text, and the finished reply shows "Worked for" (slow fake engine) |
| `75-card-wording` | The memory card wording follows the engine kind: unknown kind shows no claim, `strata` shows the per-engine sentence, `llama.cpp` shows "Fully on the card"; "Context limit" is shown and "Conversation length", "Room for roughly" are gone (fake engine, kind set through the engine object) |
| `76-arena-keeps` | An answered Arena round survives leaving the tab: both answers, their stats and the vote buttons come back as they were, a cast vote stays in the record, and a round left while still running says "Stopped when you left" and runs only the sides that never finished (fake engine) |
| `77-arena-system` | Arena's optional per-side instructions reach the engine as each side's system prompt (the fake engine echoes them with `--echo-system`), the instructions stay hidden with the names and appear after the vote, the same model can be picked twice, and the saved vote records both system prompts (fake engine) |
| `78-tests-setup` | The Tests set-up card explains itself, names the model and shows six question types with counts; with nothing ticked Start is disabled with a reason; two types with 3 questions each run exactly 6 questions and only those types are saved (fake engine) |
| `79-tests-own` | Your own questions run as the "Your questions" type: one with an expected answer is graded right, one without is listed under "Read these yourself" with its saved answer, and its question text opens in the detail panel (fake engine) |
| `80-slow-start` | When the status says the loaded model started slowly, the Models screen shows the plain sentence and a Reload model button; a fast or missing warm-up shows neither (the status is fed through the engine's own handler, fake engine) |
| `81-arena-bank` | Arena takes its question, its type tag and its difficulty tag from the six question files (served by the check on a spare port and pointed at with `?qbase=`), four draws in a row do not repeat, and a `?qbase=` that will not load leaves Arena with no question and Start off (fake engine) |
| `82-tests-graded` | A Tests run over fixture questions with `[[reply:...]]` markers grades one answer right, one wrong and one rules question failed, and the result view shows the counts, the expected text and the reason sentence (fake engine) |
| `83-tests-empty-answer` | A model that finishes normally but writes no answer (a thinking model out of room) is marked wrong with a no-answer reason; the run is still saved |
| `84-tests-pace` | Tests shows three answer-length choices, each with a time from the loaded model; the long choice gives a hard question 2,000 tokens, and the short choice skips hard questions |
| `85-tests-hard-set` | Tests has one question set, the benchmark bank (10 per type, 60 in all), no set chooser, and the removed hand-written set is not served |
| `86-chat-avg` | Chat avg belongs to one chat: a new chat starts empty, returning shows its own average, reset clears only that chat |
| `88-chat-speed-graph` | The speed graph's scale grows for a fast reply and reads on hover; sidebars resize, fold and remember their size; no spinner arrows or orange focus outlines |
| `89-models-add` | Add model reads a .gguf path, shows a fit estimate, lists the model as Added, loads it through the normal switch, edits and removes it |
| `90-arena-options` | Arena category chips and difficulty pick the question, Thinking reaches the engine, a 5-round match counts rounds, answers are checked after the vote, choices survive a reload |
| `91-model-settings` | Models › ⋯ › Settings: a saved temperature, top-k and stop text reach the engine on the next Chat request, the row shows Customized, a script-launched model's Load tab is read-only, Reset clears it |

## Adding a check

Create `tools/ui_checks/<NN>-<short-name>.mjs`. The number sets the run order. The `name` must
equal the file name without `.mjs`, because `--only` uses it.

```js
// Chat shows the model chip after load.
export const name = "30-chip-after-load";

export async function run(t) {
  await t.open("chat");
  // The chip says "No model loaded" until the first status poll arrives. Wait for the model name.
  await t.waitFor(`document.querySelector("#topbar .chip")?.innerText.includes("fake-model")`);
  const text = await t.text("#topbar .chip");
  t.assert(text.includes("fake-model"), `chip shows "${text}"`);
}
```

Then run `node tools/ui_check.mjs --only 30-chip-after-load`.

## Release regression checks

| Check | What it proves |
| --- | --- |
| 92-tests-history | Start waits for saved IDs; navigation ignores stale history; old runs survive; full questions and answers are stored |
| 93-chat-save-owner | A reply finishes into its original chat after switching chats; system-only edits persist; queued deletion stays with its chat |
| 94-arena-model-identity | The selected live catalogue model receives both requests and the vote records the same identities |
| 95-release-layout | Demo screens fit at 1440 and 1024 pixels; layout screenshots are saved under data/test-artifacts/shots |

Check 33 also clicks Try again after recovery and verifies a new request. Each verification step retains its complete output under data/test-artifacts/verify. The browser suite has a 10-minute total budget and a 90-second per-check budget. Headless Chrome runs with GPU rendering disabled. All subprocesses are hidden on Windows.

To keep a test run out of your normal temp folders, set TEMP and TMP to a directory under data/, and ARENA_LOCK_DIR to a lock inside it. An explicit ARENA_ENGINE on a spare port isolates imports; the catalogue-only tests also stub engine requests and use temporary paths.
