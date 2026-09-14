// Governed-lifecycle engine — operation status machine helpers.
//
// Deliberately small: predicates and a compensation-kind classifier. The actual
// step sequences live as plain code in engine.ts (no workflow-scripting layer).

import type { FailureStage, OpAction, OpStatus } from "./types.ts";

export const OP_STATUS_ORDER: OpStatus[] = [
  "pending",
  "applying",
  "indexing",
  "verifying",
  "completed",
];

export function isTerminal(status: OpStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Is this failed stage safe to simply re-run forward? True for every idempotent
 * index step. `cutover_flip` is NOT resumable-in-place — a half-applied
 * active-flag flip needs the rollback/complete decision made from the operation
 * record (compensationKind -> 'rollback_activation').
 */
export function isResumableStage(stage: FailureStage | null | undefined): boolean {
  switch (stage) {
    case "index":
    case "verify":
    case "cutover_stalemark":
    case "cutover_restamp":
    case "cutover_cleanup":
    case "cutover_stale_clear":
    case "restamp":
    case "restamp_stale_clear":
      return true;
    case "apply":
    case "cutover_flip":
    case "compensate":
      return false;
    default:
      return false;
  }
}

export type CompensationKind = "resume" | "rollback_activation" | "manual";

/**
 * How reconcile should recover a failed operation. Driven ONLY by (action,
 * failureStage) recorded on the operation — never by inspecting scattered rows.
 */
export function compensationKind(
  action: OpAction,
  stage: FailureStage | null | undefined,
): CompensationKind {
  if (stage && isResumableStage(stage)) return "resume";
  if ((action === "activate" || action === "supersede") && stage === "cutover_flip") {
    return "rollback_activation";
  }
  if (stage === "apply") return "resume"; // nothing was written yet; safe to retry from the top
  // A build that died before recording any stage (connection dropped
  // mid-request) has the same deterministic recovery as a recorded 'index'
  // failure: stale-mark + rebuild + verify + clear.
  if (action === "build_draft_index") return "resume";
  return "manual";
}