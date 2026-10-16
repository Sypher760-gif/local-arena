# Model switching

Local Arena connects to OpenAI-compatible servers and starts GGUFs through llama-server. Optional Strata, Bonsai, MiniCPM and NInfer integrations call existing scripts. Switching is disabled by default. ARENA_SWITCH_REAL=1 enables it; ARENA_SWITCH_FAKE=1 takes precedence and uses test ports only.

Ignored config/models.json, or ARENA_MODELS, lists script-managed models. Fresh clones use empty config/models.example.json. Models added through the app live in data/user-models.json.

Catalogue entries use id, name, version, engine, contextTokens, matchId and port. Script entries include start: {script, args}; Strata uses configPath. Optional portFile supplies the launcher's actual port. Profiles sharing a matchId need matchContext. Use the Models screen to add GGUFs.

Launcher script paths have no defaults. Set them with ARENA_STRATA_HOME, ARENA_BONSAI_HOME, ARENA_FAMILY_STOP, ARENA_NINFER_LAUNCH, ARENA_MINICPM_HOME and ARENA_NINFER_DISTRO. Ignored config/launcher.local.json can set strataHome, bonsaiHome, familyStop, ninferLaunch and minicpmHome. NInfer defaults to Ubuntu-24.04. Listing WSL does not start it. Existing scripts are never edited.

Direct engines Local Arena starts are recorded with PID and creation identity in data/live/owned-engines.json. Ownership survives gateway restart and rejects reused PIDs. A corrupt record blocks stopping rather than guessing. External servers remain independent; unload disconnects them. Legacy stop scripts control their own behavior and must be configured accordingly.

Loads report stopping, loading, warming, ready or failed. Loading stays locked through warm-up. Failed optional timing-history writes are logged without failing a loaded model. Real mode ignores test seeds.

A valid selected endpoint has precedence over other answering catalogue ports during adoption. Fake mode never probes real ports. An explicit ARENA_ENGINE without real switching pins that address.

Use fake engines and ARENA_PORT_OFFSET=300 for checks. Real switching, WSL and GPU performance require separate manual acceptance.
