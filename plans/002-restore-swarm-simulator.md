# Plan 002: Restore the Swarm simulator and make its runner fail visibly

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. Touch only the files listed as in scope. If a STOP condition occurs, stop and report; do not improvise. Commit the completed implementation in the isolated worktree. Do not update `plans/README.md`; the reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 65045b8..HEAD -- sims/swarm-sim.js sims/run-swarm.sh sims/package.json sims/results-swarm.md`
> Plan 001 intentionally changes `sims/package.json`; that exact dependency change is expected. Stop for any other material drift in the in-scope files.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-establish-verification-baseline.md`
- **Category**: tests
- **Planned at**: commit `65045b8`, 2026-07-13

## Why this matters

`sims/swarm-sim.js` no longer initializes against the current Swarm DOM because its stub still defines the retired embedded-tree IDs. Direct execution fails on `buyBtnFull`, while `sims/run-swarm.sh` discards stderr and pipes through `head` without `pipefail`, allowing that failure to be hidden and malformed result rows to be written. The checked-in Swarm balance/performance report therefore cannot be reproduced against the checked-in game. This plan repairs the harness, makes the batch wrapper propagate failures, and adds a short initialization smoke to the verification baseline from Plan 001.

## Current state

- `sims/swarm-sim.js:40-44` hardcodes old tree IDs including `coinsLabel`, `treeSvg`, `treeNodes`, `nodeInfo`, `buyBtn`, and `respecBtn`.
- The current game uses these literal IDs that the harness does not provide:

```text
buyBtnFull, coinsLabelFull, homeBtn, nodeInfoFull, openTreeBtn,
pauseHomeBtn, pauseMuteBtn, pauseNewRunBtn, respecBtnFull,
treeBackBtn, treeCoinBadge, treeNodesFull, treeScreen, treeSvgFull
```

- `games/swarm.html:1682` attaches a listener to `buyBtnFull` during initialization, producing the current null dereference before any simulated frame runs.
- Keep dynamic report elements such as `dmgTable`, `dpsCanvas`, `winDmgTable`, and `winDpsCanvas`; they are passed through variable-based `el(target)` calls even though a literal-ID scan may not see them.
- `sims/run-swarm.sh:14-22` uses `2>/dev/null | head -1`. With only `set -e`, the pipeline status comes from `head`, so the Node failure is masked.
- Plan 001 establishes `npm test`, the package lock, and a syntax gate. Match those scripts rather than creating a second verification entry point.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Reproduce before fix | `node sims/swarm-sim.js games/swarm.html 1` | currently exits nonzero at `buyBtnFull` |
| Direct smoke after fix | `node sims/swarm-sim.js games/swarm.html 1` | exit 0; first output line is valid JSON with `profile`, `time`, and `kills` |
| Package smoke | `npm run swarm:smoke` from `sims/` | exit 0; valid JSON output |
| Full verification | `npm test` from `sims/` | exit 0 and includes Swarm smoke |
| Shell syntax on Windows | `& 'C:\Program Files\Git\bin\bash.exe' -n sims/run-swarm.sh` | exit 0 |

## Scope

**In scope (only these files):**

- `sims/swarm-sim.js`
- `sims/run-swarm.sh`
- `sims/package.json`
- `sims/results-swarm.md`

**Out of scope:**

- Do not change `games/swarm.html`; this plan repairs the harness to match the game.
- Do not tune gameplay, AI policy, weapons, upgrade-tree costs, or balance thresholds.
- Do not regenerate the long raw batch files or change headline balance numbers.
- Do not modify other simulators or CI YAML; Plan 001 owns the baseline/CI structure.
- Do not install new dependencies.

## Git workflow

- Branch: `codex/verification-and-swarm-harness`
- One commit for this plan after Plan 001, e.g. `Restore Swarm balance simulator`.
- Do not push or open a pull request.

## Steps

### Step 1: Synchronize the DOM stub with the live game

Update the `ids` fixture in `sims/swarm-sim.js` to provide every current literal element accessed by `games/swarm.html`. Replace the six retired embedded-tree IDs with the current full-screen tree IDs and add the missing title/pause/home/DPS elements. Preserve dynamically referenced report elements.

Add a startup sanity check before evaluating the game script that compares the live game's literal `el("...")`/`getElementById("...")` references against the stub map and throws one actionable error listing every missing ID. This prevents the next DOM rename from degrading into a single null dereference. The check may intentionally ignore IDs reached only through dynamic variables, because those remain explicitly listed in the fixture.

Give the game HTML argument a repository-relative default (`../games/swarm.html` resolved from `__dirname`) while preserving the existing explicit path argument behavior.

**Verify**: `node sims/swarm-sim.js games/swarm.html 1` -> exit 0 and a valid JSON first line. Then run `node sims/swarm-sim.js` with no HTML argument and a one-second duration using the documented argument shape -> same result.

### Step 2: Make the batch wrapper propagate Node and JSON failures

Update `sims/run-swarm.sh` so that:

- It enables `set -euo pipefail`.
- It does not discard Node stderr.
- It captures the simulator output only after the Node process exits successfully, extracts the first result line without a failure-masking pipeline, validates that line as JSON, and only then appends the wrapper JSONL row.
- It supports a `SWARM_GAME` environment override for the game path so failure propagation can be tested without altering source files.
- It retains the existing default tiers, run counts, durations, output shape, and output destination.

Do not silently continue after any failed tier/run.

**Verify**: run shell syntax validation. Then invoke the runner with `SWARM_GAME` pointing to a nonexistent file and an output path in the disposable worktree/temp directory -> nonzero exit, no `DONE` message, and no successful result row.

### Step 3: Add Swarm initialization to the default gate

Update `sims/package.json` from Plan 001:

- Add `swarm:smoke` that runs the default Swarm HTML for one simulated second.
- Append `swarm:smoke` to `test` after syntax and Warband mechanics checks.
- Keep long balance scripts separate from `test`.

**Verify**: `npm test` from `sims/` -> exit 0 and output shows syntax, Warband mechanics, and Swarm smoke all ran.

### Step 4: Correct the reproducibility documentation

Update `sims/results-swarm.md` only where it describes selectors or reproduction behavior:

- Replace obsolete embedded-tree selectors with the current full-screen tree selectors.
- State that the batch wrapper now fails on simulator/JSON errors.
- Do not change existing recorded balance numbers or claim they were regenerated in this implementation.

**Verify**: `rg -n "treeNodes|buyBtn|respecBtn" sims/results-swarm.md` -> no obsolete selector claims remain; current `*Full` selectors are named instead.

## Test plan

- Direct initialization smoke with explicit HTML path.
- Direct initialization smoke with the new default HTML path.
- Startup-sanity negative test: temporarily remove one stub ID in the disposable worktree, confirm the error lists the missing ID, then revert the temporary edit.
- Failure-propagation test using a nonexistent `SWARM_GAME` path.
- Full `npm test` from Plan 001.
- Inspect the first successful simulator output line with `JSON.parse` to ensure success is not inferred merely from exit status.

## Done criteria

- [ ] `node sims/swarm-sim.js games/swarm.html 1` exits 0 and emits valid result JSON.
- [ ] The simulator works with its default game path.
- [ ] The startup sanity check reports all missing literal DOM IDs in one actionable error.
- [ ] `run-swarm.sh` uses `set -euo pipefail`, preserves stderr, validates result JSON, and returns nonzero for a nonexistent `SWARM_GAME`.
- [ ] `npm run swarm:smoke` exits 0.
- [ ] `npm test` exits 0 and includes the Swarm smoke.
- [ ] `results-swarm.md` contains no obsolete selector claims and no balance numbers were regenerated.
- [ ] `git status --short` shows changes only in the four in-scope paths for this plan, in addition to the already committed Plan 001 files.

## STOP conditions

- Stop if the repaired harness exposes a runtime error in the live game rather than a missing/incomplete stub behavior.
- Stop if one-second simulation requires gameplay or balance changes in `games/swarm.html`.
- Stop if reliable batch failure propagation requires changing the JSONL schema consumed by existing result files.
- Stop if Plan 001's `npm test` contract is absent or materially different from the expected syntax + mechanics structure.
- Stop if any other game or simulator must be changed.

## Maintenance notes

The hardcoded DOM fixture is acceptable for this lightweight harness only because the new startup check makes drift explicit. Reviewers should confirm it detects all literal element accesses and still preserves dynamic report elements. Future Swarm DOM changes must update both the real HTML and this fixture; CI should then fail at `swarm:smoke` until they agree.

