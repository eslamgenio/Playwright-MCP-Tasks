import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (the folder that contains `dist/`). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where per-task state (task.json, logs, reports) is persisted. */
export const RUNS_DIR = path.resolve(process.env.PW_MCP_RUNS_DIR ?? path.join(ROOT_DIR, '.runs'));

export const DEMO_PROJECT_DIR = path.join(ROOT_DIR, 'demo-project');
export const REPORTER_PATH = path.join(ROOT_DIR, 'dist', 'reporter.cjs');
export const RUNNER_PATH = path.join(ROOT_DIR, 'dist', 'runner.js');

const TASK_ID_RE = /^pw-(run|install)-[A-Za-z0-9-]{1,100}$/;

export function isValidTaskId(id: string): boolean {
    return TASK_ID_RE.test(id);
}

export function taskDir(taskId: string): string {
    return path.join(RUNS_DIR, taskId);
}

/**
 * Resolve the Playwright project directory: explicit argument, then
 * PLAYWRIGHT_PROJECT_DIR, then the bundled demo project.
 */
export function resolveProjectDir(arg?: string): string {
    const dir = path.resolve(arg ?? process.env.PLAYWRIGHT_PROJECT_DIR ?? DEMO_PROJECT_DIR);
    if (!existsSync(dir)) throw new Error(`Playwright project directory not found: ${dir}`);
    const hasConfig = readdirSync(dir).some(f => /^playwright\.config\.(ts|js|mjs|cjs|mts|cts)$/.test(f));
    if (!hasConfig) throw new Error(`No playwright.config.* found in ${dir}`);
    return dir;
}

/**
 * Find Playwright's CLI entry point for a project by walking up node_modules,
 * so we can run it with `node` directly (no npx/shell quirks on Windows).
 */
export function findPlaywrightCli(projectDir: string): string | undefined {
    let dir = projectDir;
    for (;;) {
        for (const pkg of ['@playwright/test', 'playwright']) {
            const cli = path.join(dir, 'node_modules', pkg, 'cli.js');
            if (existsSync(cli)) return cli;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}
