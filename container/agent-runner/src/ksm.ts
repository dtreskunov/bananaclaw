/**
 * KSM (Kernel Same-page Merging) opt-in.
 *
 * KSM only deduplicates anonymous pages that a process has explicitly marked
 * MADV_MERGEABLE. Container/LXC process pages are NOT mergeable by default, so
 * even with the host scanner enabled (`/sys/kernel/mm/ksm/run=1`) nothing is
 * shared unless each process opts in.
 *
 * `prctl(PR_SET_MEMORY_MERGE, 1)` marks the calling process's current and
 * future anonymous mappings mergeable, and the flag is INHERITED across
 * fork/exec. Calling it once on the agent-runner at startup therefore covers
 * every child it spawns — notably `opencode serve` and any MCP servers — so
 * multiple warm OpenCode instances can share their identical decompressed code
 * pages.
 *
 * The scanner itself lives on the host kernel and must be enabled separately
 * (on Proxmox: `/sys/kernel/mm/ksm/run`, typically managed by ksmtuned). This
 * opt-in is a cheap one-time syscall and a no-op when the scanner is off, so it
 * is safe to enable by default. Set `KSM_MERGE=0` (or false/no/off) to disable.
 */

import { dlopen, FFIType } from 'bun:ffi';

// From <linux/prctl.h>
const PR_SET_MEMORY_MERGE = 67;
const PR_GET_MEMORY_MERGE = 68;

function disabledByEnv(): boolean {
  const v = (process.env.KSM_MERGE ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * Opt this process (and, by inheritance, all children) into KSM page merging.
 * Never throws — on any failure it logs and returns so startup is unaffected.
 */
export function maybeEnableKsm(log: (msg: string) => void): void {
  if (disabledByEnv()) {
    log('KSM opt-in disabled via KSM_MERGE');
    return;
  }

  let lib: ReturnType<typeof dlopen> | undefined;
  try {
    lib = dlopen('libc.so.6', {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });

    const prctl = lib.symbols.prctl as unknown as (
      option: number,
      arg2: bigint,
      arg3: bigint,
      arg4: bigint,
      arg5: bigint,
    ) => number;

    const rc = prctl(PR_SET_MEMORY_MERGE, 1n, 0n, 0n, 0n);
    if (rc !== 0) {
      log(`KSM opt-in: prctl(PR_SET_MEMORY_MERGE) returned ${rc}`);
      return;
    }

    const state = prctl(PR_GET_MEMORY_MERGE, 0n, 0n, 0n, 0n);
    log(`KSM opt-in enabled (state=${state}); children inherit mergeable pages`);
  } catch (err) {
    log(`KSM opt-in unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lib?.close();
  }
}
