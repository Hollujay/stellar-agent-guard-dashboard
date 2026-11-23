import { rpc } from "@stellar/stellar-sdk";
import type { Contact } from "./addressBook.ts";
import * as guardOps from "./guardOps.ts";
import type { GuardSnapshot } from "./guardOps.ts";
import { NETWORK, DEFAULT_FLEET_PROBE_CONCURRENCY } from "./network.ts";

export type DerivedStatus = "Active" | "Frozen" | "Expired" | "Unknown";

export { DEFAULT_FLEET_PROBE_CONCURRENCY };

export interface FleetRow {
  contact: Contact;
  snapshot: GuardSnapshot | null;
  error?: string | undefined;
  derivedStatus: DerivedStatus;
  spend24h: bigint;
  dmsCountdownSecs: bigint | null;
  network: string;
  retry?: () => Promise<FleetRow>;
}

export type ReadSnapshotFn = typeof guardOps.readGuardSnapshot;

export interface PollFleetOptions {
  /** Maximum concurrent probe requests in flight. Defaults to DEFAULT_FLEET_PROBE_CONCURRENCY (5). */
  concurrency?: number;
  /** Optional cancellation signal to abort ongoing and queued probes on context change. */
  signal?: AbortSignal;
  /** Custom read snapshot function, defaults to guardOps.readGuardSnapshot. */
  readSnapshot?: ReadSnapshotFn;
}

export async function pollFleet(
  server: rpc.Server,
  contacts: Contact[],
  optionsOrReadSnapshot?: PollFleetOptions | ReadSnapshotFn,
  legacyOptions?: PollFleetOptions,
): Promise<FleetRow[]> {
  const isFn = typeof optionsOrReadSnapshot === "function";
  const _readSnapshot: ReadSnapshotFn = isFn
    ? optionsOrReadSnapshot
    : (optionsOrReadSnapshot?.readSnapshot ?? guardOps.readGuardSnapshot);
  const opts: PollFleetOptions = isFn ? (legacyOptions ?? {}) : (optionsOrReadSnapshot ?? {});

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_FLEET_PROBE_CONCURRENCY);
  const signal = opts.signal;

  const rows: FleetRow[] = new Array(contacts.length);
  let nextIndex = 0;

  async function probeContact(contact: Contact, index: number): Promise<void> {
    if (signal?.aborted) {
      rows[index] = {
        contact,
        snapshot: null,
        error: "Probe cancelled on context change",
        derivedStatus: "Unknown",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: NETWORK.name,
        retry: async (): Promise<FleetRow> => {
          const results = await pollFleet(server, [contact], _readSnapshot);
          return results[0]!;
        },
      };
      return;
    }

    try {
      const snapshot = await _readSnapshot(server, contact.address);
      if (signal?.aborted) {
        rows[index] = {
          contact,
          snapshot: null,
          error: "Probe cancelled on context change",
          derivedStatus: "Unknown",
          spend24h: 0n,
          dmsCountdownSecs: null,
          network: NETWORK.name,
        };
        return;
      }

      let derivedStatus: DerivedStatus = "Unknown";
      let dmsCountdownSecs: bigint | null = null;
      let spend24h = 0n;

      if (snapshot.status.ok) {
        const s = snapshot.status.value;
        if (
          s &&
          typeof s === "object" &&
          typeof s.admin_frozen === "boolean" &&
          typeof s.heartbeat_expired === "boolean"
        ) {
          if (s.admin_frozen) {
            derivedStatus = "Frozen";
          } else if (s.heartbeat_expired) {
            derivedStatus = "Expired";
          } else {
            derivedStatus = "Active";
          }

          if (snapshot.policy.ok && snapshot.policy.value) {
            const grace = snapshot.policy.value.dms_grace_secs;
            const lastHb = s.last_heartbeat;
            const now = s.now;
            if (
              typeof grace === "bigint" &&
              typeof lastHb === "bigint" &&
              typeof now === "bigint"
            ) {
              if (grace > 0n && lastHb > 0n) {
                const remaining = lastHb + grace - now;
                dmsCountdownSecs = remaining > 0n ? remaining : 0n;
              }
            }
          }
        } else {
          derivedStatus = "Unknown";
        }
      }

      if (snapshot.window.ok && snapshot.window.value) {
        spend24h = snapshot.window.value.total;
      }

      rows[index] = {
        contact,
        snapshot,
        derivedStatus,
        spend24h,
        dmsCountdownSecs,
        network: NETWORK.name,
        retry: async (): Promise<FleetRow> => {
          const results = await pollFleet(server, [contact], _readSnapshot);
          return results[0]!;
        },
      };
    } catch (error) {
      rows[index] = {
        contact,
        snapshot: null,
        error: error instanceof Error ? error.message : String(error),
        derivedStatus: "Unknown",
        spend24h: 0n,
        dmsCountdownSecs: null,
        network: NETWORK.name,
        retry: async (): Promise<FleetRow> => {
          const results = await pollFleet(server, [contact], _readSnapshot);
          return results[0]!;
        },
      };
    }
  }

  const workerCount = Math.min(concurrency, contacts.length);
  if (workerCount === 0) return [];

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < contacts.length) {
      if (signal?.aborted) {
        while (nextIndex < contacts.length) {
          const i = nextIndex++;
          await probeContact(contacts[i]!, i);
        }
        break;
      }
      const i = nextIndex++;
      await probeContact(contacts[i]!, i);
    }
  });

  await Promise.all(workers);
  return rows;
}

export function filterFleet(
  rows: FleetRow[],
  search: string,
  networkFilter: string | null,
  statusFilter: DerivedStatus | null,
): FleetRow[] {
  const q = search.toLowerCase();
  return rows.filter((row) => {
    if (networkFilter && row.network !== networkFilter) return false;
    if (statusFilter && row.derivedStatus !== statusFilter) return false;
    if (q) {
      const labelMatch = row.contact.label.toLowerCase().includes(q);
      const addressMatch = row.contact.address.toLowerCase().includes(q);
      if (!labelMatch && !addressMatch) return false;
    }
    return true;
  });
}

export type SortKey = "label" | "address" | "status" | "spend" | "expiration";

export type SortDirection = "asc" | "desc";

/** Every sort key, in the order the table's sort control lists them. */
export const SORT_KEYS: readonly SortKey[] = ["label", "address", "status", "spend", "expiration"];

/**
 * The direction a key sorts in before the operator flips it: spend is
 * "biggest first" (the existing behaviour), everything else reads ascending.
 */
export function defaultSortDirection(key: SortKey): SortDirection {
  return key === "spend" ? "desc" : "asc";
}

/**
 * Where each live status sits when sorting by status, ascending: the rows that
 * need an operator first. `Unknown` (the read failed or was never made) has its
 * own rank between the unhealthy states and `Active`, so an unread guard is
 * never grouped with — or mistaken for — a guard confirmed healthy.
 */
export const STATUS_SORT_RANK: Readonly<Record<DerivedStatus, number>> = {
  Frozen: 0,
  Expired: 1,
  Unknown: 2,
  Active: 3,
};

/**
 * Label order that is the same on every machine and reads the way people expect:
 * case-insensitive, with digit runs compared as numbers ("Guard 2" before
 * "Guard 10").
 */
const LABEL_COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareByKey(a: FleetRow, b: FleetRow, key: SortKey): number {
  switch (key) {
    case "label":
      return LABEL_COLLATOR.compare(a.contact.label, b.contact.label);
    case "address":
      return a.contact.address < b.contact.address
        ? -1
        : a.contact.address > b.contact.address
          ? 1
          : 0;
    case "status":
      return STATUS_SORT_RANK[a.derivedStatus] - STATUS_SORT_RANK[b.derivedStatus];
    case "spend":
      return compareBigint(a.spend24h, b.spend24h);
    case "expiration":
      // Callers handle missing countdowns before reaching here.
      return compareBigint(a.dmsCountdownSecs ?? 0n, b.dmsCountdownSecs ?? 0n);
  }
}

/**
 * Sort fleet rows deterministically, without mutating the input.
 *
 * `rows` is expected in registry order. Ties on the chosen key are broken by
 * each row's position in that input — in the same direction regardless of
 * `direction` — so equal rows never reshuffle between polls or when the
 * direction is flipped, and the underlying registry order is what survives
 * every sort. A `null` key is the default order: the input, untouched.
 *
 * For `expiration`, a row with no countdown has nothing to compare, so it goes
 * last in both directions rather than being treated as "zero seconds left".
 */
export function sortFleet(
  rows: FleetRow[],
  sortKey: SortKey | null,
  direction: SortDirection = sortKey ? defaultSortDirection(sortKey) : "asc",
): FleetRow[] {
  if (!sortKey) return rows;
  const sign = direction === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (sortKey === "expiration") {
        const aMissing = a.row.dmsCountdownSecs === null;
        const bMissing = b.row.dmsCountdownSecs === null;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (aMissing && bMissing) return a.index - b.index;
      }
      const byKey = compareByKey(a.row, b.row, sortKey) * sign;
      return byKey !== 0 ? byKey : a.index - b.index;
    })
    .map((entry) => entry.row);
}
