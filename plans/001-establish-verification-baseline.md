# Plan 001: Establish a fail-fast verification baseline before deployment

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. Touch only the files listed as in scope. If a STOP condition occurs, stop and report; do not improvise. Commit the completed implementation in the isolated worktree. Do not update `plans/README.md`; the reviewer maintains the index.
>
> **Drift check (run first)**: `git diff --stat 65045b8..HEAD -- README.md .github/workflows/deploy.yml sims/package.json sims/package-lock.json sims/check-syntax.js`
> If an in-scope file changed since this plan was written, compare the current-state excerpts below against live code. Stop if behavior or project structure changed materially.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / DX
- **Planned at**: commit `65045b8`, 2026-07-13

## Why this matters

The repository deploys directly to GitHub Pages without running any verification. `sims/package.json` has no `test` or syntax-check command, there is no lockfile, and the deployment workflow contains only publishing steps. A recent DOM rename already broke the Swarm harness without being detected. This plan creates a reproducible dependency install, one local command (`npm test` from `sims/`), and a CI gate that must pass before the Pages deploy job runs.

## Current state

- `sims/package.json` is the only package manifest. Its scripts currently expose individual balance runs but no verification entry point:

```json
"scripts": {
  "start": "node dungeondeal-sim.js",
  "depths": "node depths-sim.js",
  "warband": "node warband-sim.js",
  "warband:mechanics": "node warband-sim.js --mechanics"
}
```

- `sims/package-lock.json` does not exist, so `npm ci` and `npm audit` fail on a clean checkout.
- `.github/workflows/deploy.yml` checks out the repository and immediately configures/uploads/deploys Pages; there is no prerequisite verification job.
- All games are static single-file HTML documents with one inline classic script. All simulator JavaScript is plain CommonJS. There is intentionally no bundler or transpiler.
- Use the explicit, readable CommonJS style in `sims/warband-sim.js` as the convention for a new checker (`'use strict'`, `require`, named functions, actionable errors).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Initial lockfile generation | `npm install --package-lock-only --ignore-scripts` from `sims/` | exit 0; `package-lock.json` created |
| Reproducible install | `npm ci` from `sims/` | exit 0 |
| Syntax gate | `npm run check:syntax` from `sims/` | exit 0; names all five games and all simulator JS files as parsed |
| Mechanics smoke test | `npm run warband:mechanics` from `sims/` | exit 0; all mechanics checks pass |
| Full baseline | `npm test` from `sims/` | exit 0 |

## Scope

**In scope (only these files):**

- `sims/check-syntax.js` (create)
- `sims/package.json`
- `sims/package-lock.json` (generate and commit)
- `.github/workflows/deploy.yml`
- `README.md`

**Out of scope:**

- Do not change any file under `games/`.
- Do not repair `sims/swarm-sim.js` or `sims/run-swarm.sh`; Plan 002 owns those changes.
- Do not run or regenerate long balance batches or modify `sims/results-*.md`.
- Do not add a bundler, TypeScript, lint framework, test framework, or production dependency.
- Do not upgrade jsdom beyond the version range already declared.

## Git workflow

- Branch: `codex/verification-and-swarm-harness`
- One commit for this plan, matching repository history's imperative summary style, e.g. `Add fail-fast verification before Pages deploy`.
- Do not push or open a pull request.

## Steps

### Step 1: Add a dependency-free syntax checker

Create `sims/check-syntax.js`. It must:

1. Resolve the repository root relative to `__dirname`.
2. Enumerate every `games/*.html` file, extract every inline `<script>...</script>` body, and compile each with Node's built-in `vm.Script` without executing it.
3. Enumerate every `sims/*.js` file, including the checker itself, and compile each with `vm.Script` without executing it.
4. Print one concise success line per parsed file/script.
5. Print the failing path and parser error and set a nonzero exit code if anything fails.
6. Fail if no game HTML files or no inline scripts are found, so a broken glob/extraction cannot pass vacuously.

Do not use regex to validate JavaScript syntax itself; regex is acceptable only to extract classic inline script bodies before `vm.Script` parses them.

**Verify**: `node sims/check-syntax.js` from the repo root -> exit 0 and success lines for all five games plus all six existing simulator JS files and the checker.

### Step 2: Define the one-command verification contract and lock dependencies

Update `sims/package.json`:

- Add `check:syntax` mapped to `node check-syntax.js`.
- Add `test` that runs `check:syntax` and the existing `warband:mechanics` command in that order.
- Add convenient named scripts for the currently omitted Loopline and Swarm harnesses, but do not include the broken Swarm harness in `test` until Plan 002 repairs it.
- Preserve all existing scripts and the existing jsdom version range.

Generate `sims/package-lock.json` with npm; do not hand-author it.

**Verify**: delete only the disposable worktree's `sims/node_modules` if present, then run `npm ci` and `npm test` from `sims/` -> both exit 0.

### Step 3: Gate Pages deployment on verification

Modify `.github/workflows/deploy.yml` so that:

- Pull requests run the verification job but never deploy.
- Pushes to `main` and manual dispatches run verification first, and `deploy` has `needs: verify`.
- The verification job uses `actions/checkout@v4`, `actions/setup-node@v4` with Node 22 and npm caching keyed from `sims/package-lock.json`, then runs `npm ci` and `npm test` with `working-directory: sims`.
- Pages write/id-token permissions and the Pages environment remain limited to the deploy job where possible.
- The existing Pages upload/deploy steps and concurrency behavior remain intact.

**Verify**: inspect the YAML and confirm `deploy` has `needs: verify` and a condition that excludes pull requests. Run `npm test` again locally -> exit 0.

### Step 4: Document the verification path

Update the README's Balance simulations section to prefer `npm ci` for a clean/reproducible checkout, document `cd sims && npm test` as the fast verification command, and clearly distinguish it from the longer balance batches.

**Verify**: `rg -n "npm ci|npm test|balance" README.md` -> all three concepts are present and the existing local-play/deployment instructions remain intact.

## Test plan

- Temporarily introduce a syntax error only in the disposable worktree after the checker passes, confirm `npm run check:syntax` exits nonzero and identifies the file, then revert that temporary edit before committing.
- Run the valid checker twice to confirm it is read-only and deterministic.
- Run `npm ci` followed by `npm test` from a clean dependency directory.
- Read the new CI job to confirm pull requests cannot reach deployment and `main` cannot deploy before verification succeeds.

## Done criteria

- [ ] `sims/package-lock.json` is committed and `npm ci` exits 0.
- [ ] `npm run check:syntax` parses every game inline script and simulator JS file and exits 0.
- [ ] A deliberate temporary syntax error makes the checker exit nonzero; the temporary error is reverted.
- [ ] `npm test` exits 0 and runs both syntax and Warband mechanics gates.
- [ ] The deploy job declares `needs: verify`; pull requests run verification but cannot deploy.
- [ ] README documents `npm ci`, `npm test`, and the distinction between smoke checks and balance batches.
- [ ] `git status --short` shows changes only in the five in-scope paths.

## STOP conditions

- Stop if `npm install --package-lock-only` resolves a jsdom version incompatible with Node 22.
- Stop if the existing Warband mechanics suite fails before any relevant change to it (it is out of scope).
- Stop if gating deployment requires changing the Pages publication path or repository hosting model.
- Stop if parsing the current checked-in sources reports a syntax error; report the existing error rather than weakening the checker.
- Stop if any source file under `games/` appears necessary to modify.

## Maintenance notes

Plan 002 should extend `npm test` with a short Swarm initialization smoke after repairing its DOM stub. Keep long stochastic balance batches outside the default gate; CI should remain fast and deterministic. When adding a new game or simulator, the checker should discover it automatically rather than requiring a hardcoded filename list.

