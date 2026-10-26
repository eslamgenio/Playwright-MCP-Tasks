# Playwright Tasks MCP server

A local stdio MCP server that runs Playwright test suites as **[MCP tasks](https://code.claude.com/docs/en/mcp#mcp-tasks-for-server-authors)**. A long run doesn't block the conversation. Claude Code gets a task handle right away, polls `tasks/get`, shows live progress in `/tasks`, and reports the result when the run finishes.

```
run_tests ──► { resultType: "task", taskId: "pw-run-…", status: "working" }
tasks/get ──► "6/10 done · 6 passed · running: catalog.spec.ts › lists three products [chromium]"
tasks/get ──► "8/10 done · 7 passed · 1 failed · running: login.spec.ts › …"
tasks/get ──► { status: "completed", result: { content: [...summary + failures...], isError: true } }
```

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `run_tests` | **task** | Runs `playwright test` with these optional settings: `files`, `grep`, `grepInvert`, `project`, `workers`, `retries`, `headed`, `timeoutMinutes`. The live status shows passed and failed counts and the test that is running. The final result lists failing tests with error excerpts and the HTML report path. `isError` is `true` when any test failed. |
| `install_browsers` | **task** | Runs `playwright install`, with optional `browsers` and `withDeps`. The status shows the latest download line. |
| `list_tests` | sync | Runs `playwright test --list` and shows the tests grouped by file. |
| `get_run_report` | sync | Shows details for a run (`runId` = task ID): per-test status, full errors, and trace, screenshot and video paths. With no `runId` it lists recent runs. |

Every tool accepts `projectDir`, the absolute path to a folder that contains `playwright.config.*`. When it is omitted, the server uses `PLAYWRIGHT_PROJECT_DIR`, then the bundled `demo-project/`.

## Setup

```bash
npm install
```

```bash
npm run build
```

The demo project needs its own dependencies and Chromium. Run this from inside `demo-project/`:

```bash
npm install && npx playwright install chromium
```

### Register with Claude Code

This folder includes a project-scoped [.mcp.json](.mcp.json). Start `claude` here and approve the `playwright-tasks` server.

To use the server from another folder, such as your own Playwright repo, register it with `claude mcp add` at one of these scopes:

| Scope | Where it's saved | Who gets it |
|---|---|---|
| `project` | `.mcp.json` in the folder you run the command from (commit it) | Everyone who opens that project. Each person approves it once. |
| `local` (the default) | Your `~/.claude.json`, under that folder | Only you, only in that folder |
| `user` | Your `~/.claude.json` | Only you, in every folder |

Run the command from the root folder of the project. For `project` and `local` scope, that's the folder Claude ties the server to.

```bash
claude mcp add --scope project playwright-tasks --env PLAYWRIGHT_PROJECT_DIR="C:/path/to/your/playwright-project" -- node "C:/path/to/Playwright-MCP-Tasks/dist/index.js"
```

Replace both paths with absolute paths on your machine:

- `C:/path/to/Playwright-MCP-Tasks` is where you cloned this repo. Run `npm run build` first, so that `dist/index.js` exists.
- `C:/path/to/your/playwright-project` is your test suite: the folder that contains `playwright.config.*`.

Swap `--scope project` for `--scope local` or `--scope user` as needed.

- Use the same name, `playwright-tasks`, at only one scope. If two scopes define it, `local` wins over `project`, and `project` wins over `user`. To remove one, run `claude mcp remove playwright-tasks --scope <scope>`.
- Don't run `--scope project` inside this folder. It would clash with the existing [.mcp.json](.mcp.json) entry, so edit that file instead.
- Check what's registered and whether it's connected with `claude mcp list` or `claude mcp get playwright-tasks`.
- A committed `.mcp.json` contains the absolute path to `dist/index.js`. Teammates need this server built at the same path, or they need to edit the path.

To point the server at your own suite, change `PLAYWRIGHT_PROJECT_DIR`, or ask Claude to pass `projectDir`. Your project needs `@playwright/test` installed in its `node_modules`.

#### Keep run artifacts in your project

By default, each run's logs, reports, traces and screenshots go to `.runs/` inside this server's folder. To keep them next to your tests instead, set `PW_MCP_RUNS_DIR` when you register the server:

```bash
claude mcp add --scope project playwright-tasks --env PLAYWRIGHT_PROJECT_DIR="C:/path/to/your/playwright-project" --env PW_MCP_RUNS_DIR="C:/path/to/your/playwright-project/.pw-mcp-runs" -- node "C:/path/to/Playwright-MCP-Tasks/dist/index.js"
```

- Use an absolute path. A relative one is resolved against the server process's working directory.
- Add the folder (for example `.pw-mcp-runs/`) to your project's `.gitignore`.
- `get_run_report` lists runs from this folder only, so runs saved under the old location won't show up after you change it.

### Requirements for task mode (from the Claude Code docs)

- **Claude Code CLI v2.1.304 or later, in a terminal session.** The desktop app and the VS Code extension don't get MCP tasks. There, the same tools still work, but as ordinary blocking calls.
- The connection must use protocol revision 2026-07-28, which is the default. Don't set `MCP_SDK_GENERATION=v1` or `MCP_PROTOCOL_NEGOTIATION=legacy`.
- The session must fetch feature flags, so not Bedrock, Vertex or Foundry, and not with telemetry turned off.
- The call must come from the main conversation, not from a subagent. A one-shot `claude -p "…"` run doesn't get tasks.

## Using it from Claude Code (terminal CLI)

This is full task mode: runs don't block the conversation, you get live progress, and you can cancel.

### Run tests

Ask in plain language. Claude turns your request into `run_tests` arguments:

- *"Run the Playwright tests"*
- *"Run only @smoke tests on chromium with 4 workers"*
- *"Run tests/login.spec.ts with 2 retries, stop after 20 minutes"*

Claude gets a task ID right away, so the conversation isn't blocked and you can keep working while the suite runs.

With the bundled demo suite, add *"…excluding @failing"* for a green run. One test fails on purpose so you can see how failures are reported.

### Follow progress

- **Footer:** shows `1 MCP task` while the run is going.
- **`/tasks`:** shows the live status, for example `8/20 done · 7 passed · 1 failed · running: checkout.spec.ts › pays`. Claude Code polls `tasks/get` every few seconds; the server sets the interval with `pollIntervalMs`.
- **Ask Claude:** for example *"How's the test run going?"*. Claude calls `get_run_report` with the run's ID and reports the same status, the command and the timings.
- **When the run finishes,** Claude gets the summary on its own: counts, failing tests with error excerpts, and the HTML report path. For full errors and trace, screenshot and video paths, ask for the run report, for example *"Show me the failures from that run"*.

### Cancel a run

- Stop the task from `/tasks`, or tell Claude *"Stop the test run"*. Claude Code sends `tasks/cancel`.
- The server then kills the whole process tree (runner, Playwright, workers and browsers) and marks the task `cancelled`.
- A cancelled run keeps its `output.log` and `progress.json`, but has no JSON or HTML report, because Playwright is stopped before it writes them.
- **Exiting Claude Code does not cancel a run.** The run keeps going in the background, and you can follow it again when you resume the session.

### Hung tests

- Playwright's per-test timeout catches most hangs: that test fails and the run continues.
- For long suites, also ask for a time limit, for example *"…stop after 30 minutes"*. Claude passes it as `timeoutMinutes`. When the limit is reached, the run stops but still writes its reports.
- With neither in place, a stuck run stays in `working` and its status message stops changing. Cancel it by hand.

### How failures come back

**Some tests failed.** The task ends as `completed`, not `failed`, and its result has `isError: true`. Claude Code passes it to Claude as a failed tool call. The result looks like this:

```
Playwright run pw-run-20261023191345-9198d4: 10 tests: 9 passed, 1 failed, 0 flaky, 0 skipped in 35s

Failed tests (1):
✗ catalog.spec.ts:18 › applies a discount code @failing [chromium]
    Error: expect(locator).toBeVisible() failed
    Locator: getByPlaceholder('Discount code')
    Expected: visible
    Timeout: 2000ms
    Error: element(s) not found

HTML report: …\.runs\pw-run-…\html-report
Full details: call get_run_report with runId "pw-run-…".
```

- It lists up to 10 failing tests, each with file:line, title, project and the first 8 lines of its error. It also lists flaky tests and any global errors.
- Full stack traces and trace, screenshot and video paths aren't in this result. They come from `get_run_report` with `onlyFailures: true`. The summary's last line and the server's instructions both point Claude there.
- While the run is still going, `/tasks` already shows the failure count, for example `… · 1 failed · …`. The error text itself only arrives when the run ends.

**Playwright itself broke** (for example a config error, missing browsers, or a crash before any report was written). The task ends as `failed`. Claude gets `error.message`, which says what went wrong and includes the last part of Playwright's output.

**The run was cancelled or timed out.**
- Cancelled: the task ends as `cancelled`, and Claude is told "Cancelled by client".
- Hit `timeoutMinutes`: the task is `completed`, and tests that didn't run are reported as interrupted.

### How the agent acts on failures

The server only reports. What happens next is up to Claude and your prompt. A typical loop:

1. **Read the summary.** The error excerpt is often enough, for example a missing locator or a wrong expected value.
2. **Get details if needed** with `get_run_report` and `onlyFailures: true`: the full stack, the spec line, and attachment paths.
   - Claude can open failure screenshots (`.png`) with its file-read tool.
   - It can't open trace `.zip` files directly. It can give you their paths or the `npx playwright show-report` command instead.
3. **Read the code:** the spec file at that line, and the app code it exercises.
4. **Decide what kind of failure it is:**
   - a broken test (bad selector, outdated expectation)
   - a real app bug
   - environment trouble (server down, missing browser; often shows up as a `failed` task)
   - a flaky test (passed on retry)
5. **Fix or report.** If you asked for fixes, Claude edits the test or the app. Otherwise it explains what's wrong and suggests a fix.
6. **Re-run only what failed,** for example `run_tests` with `files: ["tests/catalog.spec.ts:18"]` or a `grep`. That starts a new task, and it's much faster than the full suite.

Steer it with how you ask:

- *"Run the tests and fix any failures"*: the full loop.
- *"Run the tests and tell me what failed"*: report only.
- *"…don't change app code, only tests"*: limits what Claude may edit.

For a rule that applies every time, put it in your project's `CLAUDE.md`. For example: *"After a failed run, re-run only the failed tests before reporting."*

## How it works

- **Protocol.** The server is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). It advertises `capabilities.extensions["io.modelcontextprotocol/tasks"]` in `server/discover`. It returns a task only when the request's `_meta["io.modelcontextprotocol/clientCapabilities"]` declares the extension. Otherwise it waits and returns a plain result.
- **Methods:**
  - `tasks/get` returns status, `statusMessage` and `pollIntervalMs` (3 s for runs, 2 s for installs). On `completed` it adds `result`, and on `failed` it adds `error`.
  - `tasks/cancel` kills the whole process tree with `taskkill /T` on Windows, or a process-group kill on other systems.
  - `tasks/update` is acknowledged, because this server never asks for input.
  - An unknown task ID gets error `-32602`.
- **Durability.** Each job runs in a detached runner process (`dist/runner.js`). All of its state is written under `.runs/<taskId>/`, or under `PW_MCP_RUNS_DIR` when that is set (see [Keep run artifacts in your project](#keep-run-artifacts-in-your-project)). So a run keeps going, and `tasks/get` keeps answering, if the MCP server restarts or Claude Code resumes the session.

  ```
  .runs/pw-run-20261023191345-9198d4/
    task.json      status record
    job.json       command the runner executes
    output.log     Playwright console output
    progress.json  live counters from dist/reporter.cjs
    results.json   Playwright JSON report
    html-report/   Playwright HTML report (npx playwright show-report <dir>)
    test-results/  traces, screenshots, videos
    exit.json      written when the job exits
  ```
- **Progress.** A custom reporter (`src/reporter.cts`) is added alongside the `json` and `html` reporters through `--reporter`. It writes `progress.json` at most every 500 ms, and the server turns that file into the task's `statusMessage`.

## Development

```bash
npm run smoke
```

The smoke test builds the server and talks raw JSON-RPC to it, the same way Claude Code does. It checks:

- discovery
- `list_tests`
- a task run polled to completion, across a server restart
- the progression of status messages
- `get_run_report`
- cancellation, and that the process tree is gone afterwards
- the unknown-ID error
- the blocking fallback for clients without task support

Source layout:

- `src/index.ts`: tools and the `tasks/*` handlers
- `src/tasks.ts`: task store and lifecycle
- `src/playwright.ts`: command lines
- `src/runner.ts`: detached runner
- `src/reporter.cts`: progress reporter
- `src/report.ts`: formatting of the JSON report
