// Phase 7 — reusable Operational Continuity / Knowledge Health primitives.
// Pure: no Base44 SDK, no UI, no embeddings, no LLM, no randomness.
// MindVault wiring lives in base44/shared/mindvaultHealth.ts.

export * from "./types.ts";
export * from "./freshness.ts";
export * from "./coverage.ts";
export * from "./continuityExposure.ts";
export * from "./keyPersonDependency.ts";
export * from "./continuityState.ts";
export * from "./snapshot.ts";
export * from "./reviewQueue.ts";
export * from "./presentation.ts";
export * from "./draftStuck.ts";
// Phase 9 P9-1 — historical snapshot projection + deterministic trend. Pure;
// the Phase 7 current-health engine (mindvaultHealth.ts) never imports these.
export * from "./snapshotProjection.ts";
export * from "./trend.ts";
// Phase 9 P9-2 — presentation helpers (pure): multi-period series shaping,
// governance completeness projection, Address First "why" rationale.
export * from "./trendSeries.ts";
export * from "./governanceCompleteness.ts";
export * from "./priorityRationale.ts";
// Phase 9 P9-3 — pure historical continuity/gap fingerprints + deterministic
// persisted-period vs persisted-period change detection.
export * from "./continuityChange.ts";