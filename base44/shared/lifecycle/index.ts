// Governed-lifecycle engine — public surface.
// Reusable: no Base44 SDK, no MindVault entity names, no UI. MindVault wires it
// in base44/shared/mindvaultLifecycle.ts.

export * from "./types.ts";
export * from "./policy.ts";
export * from "./stateMachine.ts";
export * from "./operationMachine.ts";
export * from "./verification.ts";
export * from "./presentation.ts";
export { createLifecycleEngine } from "./engine.ts";
export type { EngineDeps, MetadataPatch } from "./engine.ts";
