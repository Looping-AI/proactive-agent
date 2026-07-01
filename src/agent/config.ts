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
