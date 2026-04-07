#!/usr/bin/env node
/**
 * memory-save MCP Server
 * Uses official @modelcontextprotocol/sdk (CJS)
 * Tools: memory_save, memory_search
 */

const net = require('net');
const SDK = '/home/developer/.npm-global/lib/node_modules/openclaw/node_modules/@modelcontextprotocol/sdk/dist/cjs/';
const { Server } = require(SDK + 'server/index.js');
const { StdioServerTransport } = require(SDK + 'server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require(SDK + 'types.js');

const SOCKET_PATH = '/home/developer/.memory/agents-memory/daemon.sock';

function daemonCall(cmd, args) {
    return new Promise((resolve, reject) => {
        let done = false;
        const sock = net.createConnection({ path: SOCKET_PATH });
        const chunks = [];
        sock.on('data', c => chunks.push(c));
        sock.on('end', () => {
            if (done) return; done = true;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
        });
        sock.on('error', e => { if (done) return; done = true; reject(e); });
        sock.write(JSON.stringify({ cmd, args }));
        setTimeout(() => {
            if (done) return; done = true; sock.destroy(); reject(new Error('daemon timeout'));
        }, 10000);
    });
}

async function main() {
    const server = new Server(
        { name: 'memory-save', version: '1.0.0' },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'memory_save',
                description: 'Save learning to semantic memory',
                inputSchema: {
                    type: 'object',
                    properties: {
                        problem: { type: 'string', description: 'Problem or question (max 200 chars)' },
                        solution: { type: 'string', description: 'Solution or answer (max 500 chars)' },
                        collection: {
                            type: 'string',
                            enum: ['tasks', 'progress', 'plan', 'working', 'important', 'core', 'casual', 'laws', 'prompts']
                        }
                    },
                    required: ['problem', 'solution']
                }
            },
            {
                name: 'memory_search',
                description: 'Search memory for context',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        collections: { type: 'array', items: { type: 'string' } },
                        limit: { type: 'number' }
                    },
                    required: ['query']
                }
            }
        ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === 'memory_save') {
            const result = await daemonCall('write', {
                problem: (args.problem || '').slice(0, 200),
                solution: (args.solution || '').slice(0, 500),
                type: args.collection || 'working',
                metadata: {}
            });
            if (result && result.ok) {
                return { content: [{ type: 'text', text: 'Saved to ' + (args.collection || 'working') }] };
            }
            throw new Error('Save failed: ' + (result ? result.error : 'no response'));
        }

        if (name === 'memory_search') {
            const colls = args.collections || ['tasks', 'progress', 'working'];
            const limit = args.limit || 5;
            const results = [];
            for (const c of colls) {
                try {
                    const r = await daemonCall('search', { query: args.query, collection: c, limit });
                    if (r && r.ok && r.data && r.data.data) {
                        r.data.data.forEach(item => results.push({ collection: c, ...item }));
                    }
                } catch (e) { /* skip */ }
            }
            results.sort((a, b) => (a.distance || 0) - (b.distance || 0));
            const text = results.slice(0, limit)
                .map(r => '[' + r.collection + '] ' + (r.content || '').substring(0, 200))
                .join('\n\n');
            return { content: [{ type: 'text', text: text || 'No results found' }] };
        }

        throw new Error('Unknown tool: ' + name);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write('[memory-save-mcp] Server running\n');
}

main().catch(err => {
    process.stderr.write('[memory-save-mcp] Fatal: ' + err.message + '\n');
    process.exit(1);
});
