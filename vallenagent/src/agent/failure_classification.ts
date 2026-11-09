/**
 * Classification of provider failures into the recovery path the loop should take.
 * Kept as pure predicates so the retry rules are auditable and testable.
 */

/** Provider says the request itself is too large (HTTP 413 or a known context-length message). */
export function isExplicitContextOverflow(failure: string): boolean {
  return /Provider API error: 413\b/i.test(failure) ||
    /\b(?:context length exceeded|context window exceeded|maximum context|context size exceeded|too many tokens|token limit exceeded|prompt (?:is )?too long|max_model_len|request entity too large|payload too large|request_too_large)\b/i.test(failure)
}

/** Provider rejected the tool-call payload, usually malformed JSON in arguments. */
export function isMalformedToolCallError(failure: string): boolean {
  return /\binvalid (?:tool|function)(?:[_ -]?call)? arguments\b|\bmalformed tool call\b|\binvalid tool-call json\b/i.test(failure)
}

/**
 * A context-overflow failure that is really about `max_tokens` is not a prompt-size problem,
 * so it must not trigger prompt compaction.
 */
export function isCompactionWorthyOverflow(failure: string): boolean {
  return !isMalformedToolCallError(failure) && isExplicitContextOverflow(failure) && !/max_tokens/i.test(failure)
}
