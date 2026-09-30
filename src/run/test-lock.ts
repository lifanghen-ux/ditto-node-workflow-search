import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Prevent duplicate workers from evaluating the same durable test queue. */
export async function acquireTestLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "runner.lock");
  let handle;
  try { handle = await open(path, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error("Invalid Test Runner lock; inspect it before retrying");
    let alive = false;
    try { process.kill(existing.pid, 0); alive = true; }
    catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
    }
    if (alive) throw new Error(`A Test Runner already owns this output directory (PID ${existing.pid})`);
    await unlink(path);
    // Exclusive creation also resolves races between simultaneous restarts.
    handle = await open(path, "wx");
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  return async () => { await unlink(path); };
}
