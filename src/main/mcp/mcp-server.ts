import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NativeTabHost } from '../browser/native-tab-host';
import { BrowserActionRegistry } from '../browser/browser-action-registry';

export class AntiFanMcpServer {
  private server: Server;
  private registry: BrowserActionRegistry;
  private isHighRiskAllowed: boolean;

  constructor(tabHost: NativeTabHost, isHighRiskAllowed = false, registry?: BrowserActionRegistry) {
    this.registry = registry || new BrowserActionRegistry(tabHost);
    this.isHighRiskAllowed = isHighRiskAllowed;

    this.server = new Server(
      {
        name: 'antifan-browser-desktop',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.registry.listMcpTools(this.isHighRiskAllowed);
      return { tools: tools as any };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      const a = args as Record<string, any>;

      try {
        const result = await this.registry.execute(name, a, this.isHighRiskAllowed);

        // Special formatting for screenshot images
        if (name === 'antifan_screenshot' && result?.imageBase64) {
          return {
            content: [
              {
                type: 'text',
                text: `Captured ${result.imageBase64.length} base64 bytes PNG screenshot.`,
              },
              {
                type: 'image',
                data: result.imageBase64,
                mimeType: 'image/png',
              },
            ],
          };
        }

        if (name === 'antifan_get_dom' && typeof result?.html === 'string') {
          return { content: [{ type: 'text', text: result.html }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Tool error: ${errorMsg}` }] };
      }
    });
  }

  public async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

