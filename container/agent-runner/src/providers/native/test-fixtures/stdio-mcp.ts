import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'native-test', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo.value',
      description: 'Echo a value through the MCP fixture.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'wait',
      description: 'Wait before returning.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'number' } },
        required: ['ms'],
      },
    },
    {
      name: 'image',
      description: 'Return a tiny image.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Number(request.params.arguments?.ms ?? 0)));
    return { content: [{ type: 'text', text: 'waited' }] };
  }
  if (request.params.name === 'image') {
    return { content: [{ type: 'image', data: 'AQID', mimeType: 'image/png' }] };
  }
  return { content: [{ type: 'text', text: `echo:${String(request.params.arguments?.value ?? '')}` }] };
});

await server.connect(new StdioServerTransport());
