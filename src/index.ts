#!/usr/bin/env node
/**
 * Playwright Tasks MCP server (stdio).
 *
 * Long-running tools (`run_tests`, `install_browsers`) answer `tools/call`
 * with an MCP task handle when the client declares the
 * `io.modelcontextprotocol/tasks` extension, and the client then polls
 * `tasks/get`. Clients without the extension get a normal blocking result.
 *
 * Nothing but protocol messages may be written to stdout.
 */
import path from 'node:path';
import { McpServer, ProtocolError, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { isValidTaskId, resolveProjectDir, taskDir } from './paths.js';
import { installJob, runPlaywright, runTestsJob, testFilterArgs } from './playwright.js';
import { detailedReport, formatTestList, readJsonReport, stripAnsi, tailFile } from './report.js';
import {
    cancelTask,
    listTasks,
    loadTask,
    refreshTask,
    startTask,
    taskToToolResult,
    toWire,
    waitForTask,
    type TaskRecord
} from './tasks.js';

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const INVALID_PARAMS = -32602;

/** True when this request's per-request client capabilities include the tasks extension. */
function clientSupportsTasks(ctx: ServerContext): boolean {
    const envelope = ctx.mcpReq.envelope as Record<string, { extensions?: Record<string, unknown> } | undefined> | undefined;
    return Boolean(envelope?.[CLIENT_CAPABILITIES_KEY]?.extensions?.[TASKS_EXTENSION]);
}

/**
 * Answer with a task handle when the client supports tasks, otherwise wait for
 * the job and return its result directly.
 */
async function respond(task: TaskRecord, ctx: ServerContext): Promise<CallToolResult> {
    if (clientSupportsTasks(ctx)) {
        const { result: _result, error: _error, ...handle } = toWire(task);
        return { resultType: 'task', ...handle } as unknown as CallToolResult;
    }
    return taskToToolResult(await waitForTask(task.taskId, ctx.mcpReq.signal));
}

function text(t: string, isError = false): CallToolResult {
    return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) };
}

function errorResult(e: unknown): CallToolResult {
    return text(e instanceof Error ? e.message : String(e), true);
}

function requireTask(taskId: string): TaskRecord {
    if (!isValidTaskId(taskId)) throw new ProtocolError(INVALID_PARAMS, `Unknown task: ${taskId}`);
    const task = refreshTask(taskId);
    if (!task) throw new ProtocolError(INVALID_PARAMS, `Unknown task: ${taskId}`);
    return task;
}

const projectDirSchema = z
    .string()
    .optional()
    .describe('Absolute path to the Playwright project (folder with playwright.config.*). Defaults to PLAYWRIGHT_PROJECT_DIR or the bundled demo project.');

const filterSchema = {
    projectDir: projectDirSchema,
    files: z.array(z.string()).optional().describe('Test files or path filters, e.g. ["tests/login.spec.ts", "checkout"]. Supports file:line.'),
    grep: z.string().optional().describe('Only run tests whose title matches this regex (e.g. "@smoke").'),
    project: z.array(z.string()).optional().describe('Playwright project names to run (e.g. ["chromium"]).')
};

function createServer(): McpServer {
    const server = new McpServer(
        { name: 'playwright-tasks', version: '1.0.0' },
        {
            instructions:
                'Runs Playwright test suites. run_tests and install_browsers are long-running and run as MCP tasks: ' +
                'start them and keep working; the result arrives when the task finishes. Use list_tests to discover tests ' +
                'and get_run_report to inspect failures, errors and trace/screenshot paths of a finished run.'
        }
    );
    server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });

    server.registerTool(
        'run_tests',
        {
            title: 'Run Playwright tests',
            description:
                'Run Playwright tests (`playwright test`) as a long-running task with live progress (passed/failed counts and the test currently running). ' +
                'Returns a summary with failing tests and error excerpts; isError is true when any test failed. Use get_run_report for full details.',
            inputSchema: z.object({
                ...filterSchema,
                grepInvert: z.string().optional().describe('Skip tests whose title matches this regex.'),
                workers: z.number().int().positive().optional().describe('Number of parallel workers.'),
                retries: z.number().int().min(0).optional().describe('Retries for failed tests.'),
                headed: z.boolean().optional().describe('Run browsers headed (visible).'),
                timeoutMinutes: z.number().positive().optional().describe('Abort the whole run after this many minutes.')
            })
        },
        async (args, ctx) => {
            try {
                const projectDir = resolveProjectDir(args.projectDir);
                const description = ['playwright test', ...testFilterArgs(args)].join(' ');
                const task = startTask({ kind: 'run', projectDir, description, job: dir => runTestsJob(projectDir, dir, args) });
                return await respond(task, ctx);
            } catch (e) {
                return errorResult(e);
            }
        }
    );

    server.registerTool(
        'install_browsers',
        {
            title: 'Install Playwright browsers',
            description: 'Run `playwright install` for the project as a long-running task (downloads can take minutes).',
            inputSchema: z.object({
                projectDir: projectDirSchema,
                browsers: z.array(z.string()).optional().describe('Browsers to install, e.g. ["chromium", "firefox"]. Default: all configured.'),
                withDeps: z.boolean().optional().describe('Also install OS dependencies (--with-deps).')
            })
        },
        async (args, ctx) => {
            try {
                const projectDir = resolveProjectDir(args.projectDir);
                const description = ['playwright install', ...(args.withDeps ? ['--with-deps'] : []), ...(args.browsers ?? [])].join(' ');
                const task = startTask({ kind: 'install', projectDir, description, job: () => installJob(projectDir, args) });
                return await respond(task, ctx);
            } catch (e) {
                return errorResult(e);
            }
        }
    );

    server.registerTool(
        'list_tests',
        {
            title: 'List Playwright tests',
            description: 'List the tests Playwright would run (`playwright test --list`), grouped by file, without running them.',
            inputSchema: z.object(filterSchema),
            annotations: { readOnlyHint: true }
        },
        async (args, ctx) => {
            try {
                const projectDir = resolveProjectDir(args.projectDir);
                const { exitCode, stdout, stderr } = await runPlaywright(
                    projectDir,
                    ['test', '--list', '--reporter=json', ...testFilterArgs(args)],
                    ctx.mcpReq.signal
                );
                const start = stdout.indexOf('{');
                const report = start >= 0 ? (JSON.parse(stdout.slice(start)) as Parameters<typeof formatTestList>[0]) : undefined;
                if (!report) return text(`playwright test --list failed (exit ${exitCode}):\n${stripAnsi(stderr || stdout)}`, true);
                return text(`Project: ${projectDir}\n${formatTestList(report)}`, exitCode !== 0);
            } catch (e) {
                return errorResult(e);
            }
        }
    );

    server.registerTool(
        'get_run_report',
        {
            title: 'Get Playwright run report',
            description:
                'Get details of a run started by run_tests: status, per-test results, error messages and stack traces, and paths of traces/screenshots/videos. ' +
                'Without runId, lists recent runs and installs.',
            inputSchema: z.object({
                runId: z.string().optional().describe('Task ID returned by run_tests (e.g. "pw-run-20261023190000-a1b2c3").'),
                onlyFailures: z.boolean().optional().describe('Only include failed and flaky tests.'),
                includeLog: z.boolean().optional().describe('Append the tail of the Playwright console output.')
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ runId, onlyFailures, includeLog }) => {
            if (!runId) {
                const tasks = listTasks(20);
                if (!tasks.length) return text('No runs yet.');
                return text(tasks.map(t => `${t.taskId}  ${t.status.padEnd(9)}  ${t.description}\n    ${t.statusMessage ?? ''}`).join('\n'));
            }
            if (!isValidTaskId(runId) || !loadTask(runId)) return text(`Unknown run: ${runId}`, true);
            const task = refreshTask(runId)!;
            const dir = taskDir(runId);
            const lines = [
                `Run ${task.taskId} (${task.kind}): ${task.status}`,
                `Command: ${task.description}`,
                `Project: ${task.projectDir}`,
                `Started: ${task.createdAt}   Last update: ${task.lastUpdatedAt}`,
                task.statusMessage ? `Status: ${task.statusMessage}` : '',
                `Files: ${dir}`
            ].filter(Boolean);
            const report = readJsonReport(path.join(dir, 'results.json'));
            if (report) lines.push('', detailedReport(report, onlyFailures ?? false));
            else if (task.status === 'failed') lines.push('', task.error?.message ?? '');
            if (includeLog || (!report && task.kind === 'install')) lines.push('', '--- output (tail) ---', tailFile(path.join(dir, 'output.log'), 6000));
            return text(lines.join('\n'));
        }
    );

    // MCP tasks extension methods. Claude Code uses tasks/get and tasks/cancel;
    // tasks/update is acknowledged because this server never asks for input.
    const taskIdParams = z.object({ taskId: z.string() }).passthrough();
    server.server.setRequestHandler('tasks/get', { params: taskIdParams, result: z.any() }, async ({ taskId }) => ({
        resultType: 'complete',
        ...toWire(requireTask(taskId))
    }));
    server.server.setRequestHandler('tasks/cancel', { params: taskIdParams, result: z.any() }, async ({ taskId }) => {
        requireTask(taskId);
        cancelTask(taskId);
        return {};
    });
    server.server.setRequestHandler('tasks/update', { params: taskIdParams, result: z.any() }, async ({ taskId }) => {
        requireTask(taskId);
        return {};
    });

    return server;
}

serveStdio(createServer);
