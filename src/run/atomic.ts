import { rename } from "node:fs/promises";

/** Atomic publication with bounded retries for Windows file sharing.
 * Never delete the target or fall back to a non-atomic overwrite.
 */
export async function renameArtifact(temporary: string, target: string,
  operation: typeof rename = rename, delay: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await operation(temporary, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(Math.min(250, 25 * 2 ** attempt));
    }
  }
}
