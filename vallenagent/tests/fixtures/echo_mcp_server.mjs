// Minimal real MCP stdio server used by mcp_e2e.test.mjs.
// Speaks JSON-RPC over stdio through the official SDK so the test exercises the
// same transport path a user's configured MCP server would.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the given text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    },
    {
      name: 'boom',
      description: 'Always reports an error result',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'slow',
      description: 'Waits before answering',
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } } }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo:${args.text}` }] }
  if (name === 'boom') return { content: [{ type: 'text', text: 'kaboom' }], isError: true }
  if (name === 'slow') {
    await new Promise(resolve => setTimeout(resolve, Number(args.ms) || 3000))
    return { content: [{ type: 'text', text: 'slow done' }] }
  }
  throw new Error(`unknown tool: ${name}`)
})

await server.connect(new StdioServerTransport())
