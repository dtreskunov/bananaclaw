export const CONTINUE_PROMPT =
  'Continue the original request. Do not acknowledge; perform the work and report when complete.';

export function isFutureWorkMessage(body: string): boolean {
  if (!body || body.length > 240 || body.includes('?')) return false;

  const directedProgress =
    /^\s*(?:okay[,.!]?\s*)?(?:actually\s+)?(?:i(?:'m| am)\s+)?(?:working|starting|searching|researching|looking|checking|investigating|reviewing|testing|debugging)(?:\s+on)?\s+(?:it|this|that|now)(?:\s+now)?[.!]*\s*$/i;
  const executionProgress =
    /^\s*(?:okay[,.!]?\s*)?(?:actually\s+)?(?:doing\s+(?:it|this|that)(?:\s+now)?|executing(?:\s+(?:it|this|that|now))?|running\s+(?:it|this|that)\s+now)[.!]*\s*$/i;
  const futureClause =
    /(?:^|[.!]\s+)(?:understood|on it|let me|i(?:'ll| will| need to)|i(?:'m| am)\s+(?:going to|about to|starting to))\b[^.!?]*(?:search(?:ing)?|research(?:ing)?|look(?:ing)?\s+(?:into|up)|take\s+a\s+look|investigat(?:e|ing)|check(?:ing)?|dig(?:ging)?|review(?:ing)?|inspect(?:ing)?|test(?:ing)?|work(?:ing)?\s+(?:on|through)|start(?:ing)?|get\s+started|pull(?:ing)?|fix(?:ing)?|build(?:ing)?|render(?:ing)?|updat(?:e|ing)|implement(?:ing)?|creat(?:e|ing)|generat(?:e|ing)|run(?:ning)?|fetch(?:ing)?|analy[sz](?:e|ing)|compar(?:e|ing)|verif(?:y|ying)|debug(?:ging)?|set(?:ting)?\s+up|wir(?:e|ing)|edit(?:ing)?|writ(?:e|ing)|mak(?:e|ing))\b/i;
  const observationPreface = /\blet me\s+(?:check|verify|inspect|review|test)\s*:\s*\S/i;
  const negatedAction =
    /\b(?:will|would|can|could|should|do|does|did|let me)\s+(?:not|never)\b|\b(?:won't|wouldn't|can't|couldn't|shouldn't|don't|doesn't|didn't)\b/i;
  const completedStatus =
    /\b(?:is|are|was|were|has|have|had)\s+(?:already\s+)?(?:complete|completed|done|finished|updated)\b/i;
  const completedAction =
    /(?:^|[.!]\s+)(?:understood[,.]?\s*)?(?:i\s+)?(?:completed|finished|updated)\b[^.!?]*[.!]*\s*$/i;

  return (
    !observationPreface.test(body) &&
    !negatedAction.test(body) &&
    !completedStatus.test(body) &&
    !completedAction.test(body) &&
    (directedProgress.test(body) || executionProgress.test(body) || futureClause.test(body))
  );
}
