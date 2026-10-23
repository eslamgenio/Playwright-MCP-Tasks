import { spawnSync } from 'node:child_process';

/** Kill a process and all of its descendants. Best effort; never throws. */
export function killTree(pid: number): void {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            // The runner is spawned detached, so it leads its own process group.
            process.kill(-pid, 'SIGTERM');
        }
    } catch {
        // Already gone.
    }
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
