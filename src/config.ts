/**
 * Model + tool-loop constants for the agent runtime. Hardcoded (not env vars) to
 * mirror the looping-gateway admin agent; swap the ids here to change models.
 */

/** Workers AI model used by the agent tool loop. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/** Upper bound on tool-loop steps in a single turn (bounds the `generateText` loop). */
export const MAX_STEPS = 8;

/**
 * Sessions memory + compaction tuning (mirrors the admin agent's values).
 *
 * The agent keeps one continuous {@link file://./session.ts Session} per caller:
 * a writable `"memory"` scratchpad it self-edits, plus history that is compacted
 * (summarized) automatically once it grows past {@link COMPACT_AFTER_TOKENS}.
 */

/** Soft cap (tokens) for the self-edited `"memory"` scratchpad block. */
export const MEMORY_MAX_TOKENS = 1200;

/** Live-history token threshold that triggers automatic (size-based) compaction. */
export const COMPACT_AFTER_TOKENS = 60_000;

/** One-line description shown to the model for the writable `"memory"` block. */
export const MEMORY_DESCRIPTION =
  "Durable facts worth remembering across all of this caller's conversations — " +
  "stable preferences, decisions, people, and context. Keep it concise.";
