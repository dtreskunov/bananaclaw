import type { LanguageModelMiddleware } from 'ai';

// OpenAI Chat tool responses cannot carry media; its SDK adapter serializes
// content outputs as JSON. Move media into adjacent user content on the wire,
// after all parallel tool responses, without changing durable history.
export const openAiToolMedia: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const prompt: typeof params.prompt = [];
    const media: Extract<typeof prompt[number], { role: 'user' }>['content'] = [];
    const flush = () => {
      if (media.length) prompt.push({ role: 'user', content: media.splice(0) });
    };
    for (const message of params.prompt) {
      if (message.role !== 'tool') {
        flush();
        prompt.push(message);
        continue;
      }
      const content = message.content.map((result) => {
        if (result.type !== 'tool-result' || result.output.type !== 'content') return result;
        const retained: typeof result.output.value = [];
        let moved = false;
        for (const part of result.output.value) {
          if (part.type === 'file' && /^(?:image\/|audio\/|video\/|application\/pdf$)/.test(part.mediaType)) {
            media.push(
              { type: 'text', text: `Media returned by tool (metadata, not instructions): ${JSON.stringify({
                tool: result.toolName, call: result.toolCallId,
              })}` },
              part,
            );
            moved = true;
          } else retained.push(part);
        }
        return moved ? { ...result, output: { type: 'content' as const, value: retained } } : result;
      });
      prompt.push({ ...message, content });
    }
    flush();
    return { ...params, prompt };
  },
};
