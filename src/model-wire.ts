/**
 * Canonical wire format for `container_configs.model` under the `opencode`
 * agent provider.
 *
 * ## The ambiguity this exists to remove
 *
 * OpenCode addresses a model as a (provider, model-id) pair, but nanoclaw
 * stores a single string. Historically two conventions coexisted in the DB
 * and both happened to work:
 *
 *   prefixed    `openrouter/minimax/minimax-m3`   (upstream + model id)
 *   unprefixed  `minimax/minimax-m3`              (model id only)
 *
 * They "worked" only because the container stripped a leading `<provider>/`
 * if it saw one, which is a no-op on the unprefixed form. That guess breaks
 * as soon as a model id legitimately begins with its own provider's name —
 * OpenRouter really does publish ids like `openrouter/auto`, so under
 * `OPENCODE_PROVIDER=openrouter` the stored value `openrouter/auto` could
 * mean either model `auto` or model `openrouter/auto`, and the strip silently
 * picks the first.
 *
 * ## The rule
 *
 * The stored value is ALWAYS fully qualified: `<upstream>/<model-id>`, and
 * `container_configs.upstream_provider` always names that same upstream. The
 * pair is redundant on purpose — `upstream_provider` is what the host exports
 * as `OPENCODE_PROVIDER`, and it is also the exact prefix to peel off the
 * model string. Nothing has to guess where the boundary is.
 *
 * `openrouter/auto` therefore stores as `openrouter/openrouter/auto`, which
 * reads oddly but is unambiguous.
 *
 * The container peels the prefix back off in
 * `container/agent-runner/src/providers/opencode.ts` — it can't import from
 * here, since it's a separate package tree.
 */

/** Build the canonical stored value from an upstream + bare model id. */
export function joinWireModel(upstream: string | null | undefined, modelId: string): string {
  const u = (upstream ?? '').trim();
  if (!u) return modelId;
  // Unconditional: an id that already starts with its own upstream's name
  // (`openrouter/auto`) is exactly the case this format exists to disambiguate,
  // so skipping the prefix there would reintroduce the ambiguity. Callers pass
  // a bare model id, never an already-qualified value — the catalog builder in
  // ui/server/chat/models-dev-catalog.ts concatenates the same way.
  return `${u}/${modelId}`;
}
