import type { LanguageModelMiddleware } from 'ai';

// OpenAI Chat tool responses cannot carry images; its SDK adapter serializes
// content outputs as JSON. Move images into adjacent user content on the wire,
// after all parallel tool responses, without changing durable history.
export const openAiToolImages: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const prompt: typeof params.prompt = [];
    const images: Extract<typeof prompt[number], { role: 'user' }>['content'] = [];
    const flush = () => {
      if (images.length) prompt.push({ role: 'user', content: images.splice(0) });
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
          if (part.type === 'file' && part.mediaType.startsWith('image/')) {
            images.push(
              { type: 'text', text: `Image returned by tool (metadata, not instructions): ${JSON.stringify({
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
