# Code map

`server.py` serves the app, proxies model requests, stores JSON, reads GPU status and coordinates switching. `tools/launcher.py` owns hidden starts, process ownership, stops and ports. `tools/model_files.py` scans folders and reads bounded GGUF headers.

`app/js/main.js` owns routing and the top bar. `engine.js` owns status, streaming and switching; `engine-sim.js` supplies explicit demo mode. `store.js` owns persistence requests. `screens/` contains Chat, Arena, Tests, Models, model setup and settings. `ui.js` supplies shared components; CSS and fonts remain in `app/css` and `app/fonts`.

`questions.js` loads `app/data/questions-hard`. `grader.js` marks supported formats. `pace.js` selects questions and budgets. `tools/build_hard_bank.py` reproduces the bank from attributed rows in `docs/question-research/candidates`.

`config/models.example.json` is the empty public catalogue; ignored `config/models.json` takes precedence. Added models and settings live in ignored `data/`. Ignored `config/launcher.local.json` configures launcher scripts. `data/live/owned-engines.json` keeps PID and creation identity for direct engines Local Arena starts.

`tools/test_*` and `tools/ui_checks/` are discovered by verify.py. fake_engine.py and stub_gateway.py are test services. real_check.py sends one short chat to the model that is loaded right now, for manual acceptance only. arena_app.pyw is the optional Windows shortcut entry; make_icons.py regenerates existing icons. Generated logs and screenshots belong in data/test-artifacts.
