import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import type { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";
import { leaseQueries } from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  managedHandoffLeaseRow,
  type createManagedHandoffLeaseRows,
} from "./update-managed-service-handoff-rows.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;

export function prepareTerminalCancellationFamily(
  root: string,
  deps: {
    rows: Pick<Rows, "row" | "handle" | "descendants" | "deleteRow" | "sameRow">;
    withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
    transact: <T>(db: DatabaseSync, operation: () => T) => T;
    processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
    hasUnsettledChildren: (root: string, db: DatabaseSync) => boolean;
    childAliases: (key: string, db: DatabaseSync) => string[];
  },
) {
  const { rows, withDatabase } = deps;
  const inspect = (db: DatabaseSync) => {
    const selected = rows.row(db, root);
    if (!selected) {
      return null;
    }
    const mirror = rows.handle(root, selected);
    if (mirror.version !== 2 || !mirror.mutationOriginal) {
      return null;
    }
    const originalRow = rows.row(db, mirror.mutationOriginal.key);
    if (!originalRow) {
      throw new Error("Original cancellation generation is missing; retain updater evidence.");
    }
    const original = rows.handle(mirror.mutationOriginal.key, originalRow);
    if (
      original.version !== 4 ||
      original.action.kind !== "update" ||
      original.action.mutationProtocol !== "original-cancellation-v1" ||
      mirror.action.kind !== "update" ||
      mirror.action.custody ||
      mirror.owner !== original.owner ||
      !isDeepStrictEqual(original.cancellation, mirror.mutationOriginal)
    ) {
      throw new Error("Original cancellation family does not match the selected installation.");
    }
    const roots = [original.key, mirror.key];
    const children = roots.flatMap((key) =>
      rows.descendants(db, { key }).map((entry) => rows.handle(entry.install_root, entry)),
    );
    for (const child of children) {
      if (
        child.version !== 2 ||
        child.mutationOriginal ||
        child.action.kind !== "update" ||
        child.action.custody ||
        isDeepStrictEqual(child.helper, child.executor)
      ) {
        throw new Error("Cancellation family contains unsupported or unsettled child custody.");
      }
      const parentRoot = roots.find((key) =>
        child.key.startsWith(`${key}/.openclaw-update-child-`),
      )!;
      const relative = child.key.slice(parentRoot.length);
      const lineage = relative.slice(1).split("/");
      if (
        lineage.some(
          (name) => !/^\.openclaw-update-child-[a-f0-9-]{36}-lineage-[a-f0-9]{64}$/.test(name),
        ) ||
        lineage
          .slice(0, -1)
          .some(
            (_, index) =>
              !children.some(
                (entry) => entry.key === `${parentRoot}/${lineage.slice(0, index + 1).join("/")}`,
              ),
          ) ||
        (parentRoot === mirror.key && child.action.mutationProtocol) ||
        (parentRoot === original.key &&
          lineage.length === 1 &&
          child.action.mutationProtocol !== original.action.mutationProtocol)
      ) {
        throw new Error(
          "Cancellation lineage actions do not match their producer and alias roles.",
        );
      }
      const aliases = roots.map((key) => key + relative);
      if (
        aliases.some((key) => {
          const peer = children.find((entry) => entry.key === key);
          return (
            !peer ||
            peer.owner !== child.owner ||
            !isDeepStrictEqual(peer.helper, child.helper) ||
            !isDeepStrictEqual(peer.executor, child.executor)
          );
        }) ||
        deps.childAliases(child.key, db).some((key) => !aliases.includes(key))
      ) {
        throw new Error("Cancellation child aliases are missing or belong to another family.");
      }
    }
    const retained = executeSqliteQuerySync(
      db,
      leaseQueries(db).selectFrom("managed_update_handoffs").selectAll(),
    ).rows;
    const family = [original, mirror, ...children].toSorted((a, b) => a.key.localeCompare(b.key));
    if (
      retained.some(
        (entry) =>
          family.some((lease) => lease.key === entry.install_root) && entry.recovery_json != null,
      )
    ) {
      throw new Error("Cancellation family retains another repair's recovery metadata.");
    }
    const references = retained.map((entry) => rows.handle(entry.install_root, entry));
    if (
      references.some(
        (entry) =>
          entry.version === 2 &&
          isDeepStrictEqual(entry.mutationOriginal, original.cancellation) &&
          entry.key !== mirror.key,
      )
    ) {
      throw new Error("Original cancellation has another occupied installation.");
    }
    if (
      process.platform === "win32" ||
      family.some(
        (entry) =>
          deps.processState(entry.helper) !== "dead" ||
          deps.processState(entry.executor) !== "dead",
      ) ||
      roots.some((key) => deps.hasUnsettledChildren(key, db))
    ) {
      throw new Error("Cancellation owners or descendants remain live or unverified.");
    }
    return family;
  };
  const family = withDatabase(false, inspect);
  if (!family) {
    return null;
  }
  return {
    leases: family,
    retire(assertCurrent: () => void) {
      withDatabase(true, (db) =>
        deps.transact(db, () => {
          const current = inspect(db);
          if (!isDeepStrictEqual(current, family)) {
            throw new Error("Cancellation family changed during repair; no leases were retired.");
          }
          assertCurrent();
          for (const lease of family) {
            if (
              !rows.sameRow(managedHandoffLeaseRow(lease), rows.row(db, lease.key)) ||
              !rows.deleteRow(db, lease.key, managedHandoffLeaseRow(lease))
            ) {
              throw new Error("Cancellation generation changed during retirement.");
            }
          }
        }),
      );
    },
  };
}
