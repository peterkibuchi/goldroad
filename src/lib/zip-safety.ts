/**
 * Shared zip-bomb defenses for browser-side export parsing (Substack export
 * zips in ~/lib/import-zip, Medium export zips in ~/lib/import-medium): every
 * entry is inflated ONE AT A TIME, each gated by the size the central
 * directory declares AND re-checked after inflation (a bomb that lies about
 * its size still dies at the cap), with a whole-run inflated-bytes budget on
 * top. Listing entry names costs nothing (no inflation) — only per-entry
 * reads are bounded here; callers own their own entry-COUNT ceiling (checked
 * before any inflation, since each per-entry inflation re-walks the whole
 * central directory and count — not just bytes — is what would make that
 * quadratic).
 */
import { unzipSync } from "fflate";

/** The archive was refused before any entry was inflated — too many entries
 * to be a plausible export. Callers pick their own per-format ceiling and
 * throw this from their own entry-count check. */
export class ExportTooComplexError extends Error {}

/** One entry's declared-or-actual inflated size crossed the caller's cap. */
export class EntryTooLargeError extends Error {}

/** Listing pass: entry names + declared sizes only, nothing inflated. */
export function listZipEntries(bytes: Uint8Array): string[] {
  const entryNames: string[] = [];
  unzipSync(bytes, {
    filter: (file) => {
      entryNames.push(file.name);
      return false;
    },
  });
  return entryNames;
}

/** Inflates exactly one named entry, size-gated before AND after inflation
 * (central-directory sizes are attacker-controlled claims, not facts). */
function inflateEntry(
  bytes: Uint8Array,
  name: string,
  cap: number,
): Uint8Array {
  let declaredOversize = false;
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (file.name !== name) return false;
      if (file.originalSize > cap) {
        declaredOversize = true;
        return false;
      }
      return true;
    },
  });
  if (declaredOversize) throw new EntryTooLargeError();
  const data = files[name];
  if (!data) throw new Error(`entry vanished: ${name}`);
  if (data.length > cap) throw new EntryTooLargeError();
  return data;
}

/**
 * Returns an inflater closure that spends from a shared whole-run budget on
 * top of each call's own per-entry cap — the zip-bomb backstop: a handful of
 * individually-small-looking entries can't sum to an unbounded amount of
 * memory across a single parse run.
 */
export function createBudgetedInflater(
  bytes: Uint8Array,
  totalBudget: number,
): (name: string, cap: number) => Uint8Array {
  let remaining = totalBudget;
  return (name: string, cap: number): Uint8Array => {
    const data = inflateEntry(bytes, name, Math.min(cap, remaining));
    remaining -= data.length;
    return data;
  };
}
