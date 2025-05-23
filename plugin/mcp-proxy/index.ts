import { APIClientBase } from 'cluster-client';
import { MCPProxyDataClient } from './lib/MCPProxyDataClient';
import { Application, Context, EggLogger, Messenger } from 'egg';
import getRawBody from 'raw-body';
import contentType from 'content-type';
import { fetch } from 'undici';
import http from 'http';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Readable } from 'node:stream';
import cluster from 'node:cluster';
import { MCPControllerRegister, MCPControllerHook } from '@eggjs/tegg-controller-plugin/lib/impl/mcp/MCPControllerRegister';
import querystring from 'node:querystring';
import url from 'node:url';
import { Context as EggContext, Request as EggRequest, Response as EggResponse } from '@eggjs/core';

const MAXIMUM_MESSAGE_SIZE = '4mb';

export interface MCPProxyPayload {
  sessionId: string;
  message: unknown;
}

type ProxyAction = 'MCP_STDIO_PROXY' | 'MCP_SEE_PROXY' | 'MCP_STREAM_PROXY';

export enum MCPProtocols {
  STDIO = 'STDIO',
  SSE = 'SSE',
  STREAM = 'STREAM',
}

export interface ProxyMessageOptions {
  detail: ClientDetail;
  sessionId: string;
  type: MCPProtocols;
}

export interface ClientDetail {
  pid: number;
  port: number;
}

const IGNORE_HEADERS = [
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
];

export class MCPProxyApiClient extends APIClientBase {
  private _client: any;
  private logger: EggLogger;
  private proxyHandlerMap: { [P in ProxyAction]?: StreamableHTTPServerTransport['handleRequest']; } = {};
  private port: number;
  private app: Application;

  constructor(options: {
    logger: EggLogger;
    messenger: Messenger;
    app: Application;
  }) {
    super(Object.assign({}, options, { initMethod: '_init' }));
    this.logger = options.logger;
    this.port = 0;
    this.app = options.app;
  }

  addProxyHook() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const apiClient = this;

    const MCPProxyHook: MCPControllerHook = {
      async preSSEInitHandle(ctx, transport, self) {
        const id = transport.sessionId;
        // cluster proxy
        await apiClient.registerClient(id, process.pid);
        apiClient.setProxyHandler(MCPProtocols.SSE, async (req, res) => {
          const sessionId = req.query?.sessionId ?? querystring.parse(url.parse(req.url).query ?? '').sessionId as string;
          if (MCPControllerRegister.hooks.length > 0) {
            for (const hook of MCPControllerRegister.hooks) {
              await hook.preProxy?.(self.app.currentContext, req, res);
            }
          }
          let transport: SSEServerTransport;
          const existingTransport = self.transports[sessionId];
          if (existingTransport instanceof SSEServerTransport) {
            transport = existingTransport;
          } else {
            // https://modelcontextprotocol.io/docs/concepts/architecture#error-handling
            res.status(400).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Bad Request: Session exists but uses a different transport protocol',
              },
              id: null,
            });
            return;
          }
          if (transport) {
            try {
              await self.transports[sessionId].handlePostMessage(req, res);
            } catch (error) {
              self.app.logger.error('Error handling MCP message', error);
              if (!ctx.res.headersSent) {
                ctx.status = 500;
                ctx.body = {
                  jsonrpc: '2.0',
                  error: {
                    code: -32603,
                    message: `Internal error: ${error.message}`,
                  },
                  id: null,
                };
              }
            }
          } else {
            res.status(404).json({
              jsonrpc: '2.0',
              error: {
                code: -32602,
                message: 'Bad Request: No transport found for sessionId',
              },
              id: null,
            });
          }
        });
        ctx.res.once('close', () => {
          delete self.transports[id];
          const connection = self.sseConnections.get(id);
          if (connection) {
            clearInterval(connection.intervalId);
            self.sseConnections.delete(id);
          }
          apiClient.unregisterClient(id);
        });
      },
      async onStreamSessionInitialized(_ctx, transport, self) {
        const sessionId = transport.sessionId!;
        self.streamTransports[sessionId] = transport;
        apiClient.setProxyHandler(MCPProtocols.STREAM, async (req: http.IncomingMessage, res: http.ServerResponse) => {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          self.app.RequestClass = EggRequest;
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          self.app.ResponseClass = EggResponse;
          const ctx = new EggContext(self.app as any, req, res) as any;
          if (MCPControllerRegister.hooks.length > 0) {
            for (const hook of MCPControllerRegister.hooks) {
              await hook.preProxy?.(ctx, req, res);
            }
          }
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          if (!sessionId) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'session id not have and run in proxy',
              },
              id: null,
            }));
          } else {
            let transport: StreamableHTTPServerTransport;
            const existingTransport = self.streamTransports[sessionId];
            if (existingTransport instanceof StreamableHTTPServerTransport) {
              transport = existingTransport;
            } else {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: 'Bad Request: Session exists but uses a different transport protocol',
                },
                id: null,
              }));
              return;
            }
            if (transport) {
              await self.app.ctxStorage.run(ctx, async () => {
                await transport.handleRequest(ctx.req, ctx.res);
              });
            } else {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32602,
                  message: 'Bad Request: No transport found for sessionId',
                },
                id: null,
              }));
            }
          }
        });
        await apiClient.registerClient(sessionId, process.pid);
        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid && self.streamTransports[sid]) {
            delete self.streamTransports[sid];
          }
          await apiClient.unregisterClient(sid!);
        };
      },
      async checkAndRunProxy(ctx, type, sessionId) {
        const detail = await apiClient.getClient(sessionId);
        if (detail?.pid !== process.pid) {
          await apiClient.proxyMessage(ctx, {
            detail: detail!,
            sessionId,
            type,
          });
          return true;
        }
        return false;
      },
    };

    MCPControllerRegister.addHook(MCPProxyHook);
  }

  async _init() {
    const server = http.createServer(async (req, res) => {
      const type = req.headers['mcp-proxy-type'] as ProxyAction;
      await this.proxyHandlerMap[type]?.(req, res);
    });
    this.port = this.app.config.mcp?.proxyPort + (cluster.worker?.id ?? 0);
    this.addProxyHook();
    await new Promise(resolve => server.listen(this.port, () => {
      // const address = server.address()! as AddressInfo;
      // this.port = address.port;
      resolve(null);
    }));
  }

  setProxyHandler(type: MCPProtocols, handler: StreamableHTTPServerTransport['handleRequest'] | SSEServerTransport['handlePostMessage']) {
    let action: ProxyAction;
    switch (type) {
      case MCPProtocols.SSE:
        action = 'MCP_SEE_PROXY';
        break;
      case MCPProtocols.STDIO:
        action = 'MCP_STDIO_PROXY';
        break;
      default:
        action = 'MCP_STREAM_PROXY';
        break;
    }
    this.proxyHandlerMap[action] = handler;
  }

  async registerClient(sessionId: string, pid: number): Promise<void> {
    await this._client.registerClient(sessionId, {
      pid,
      port: this.port,
    });
  }

  async unregisterClient(sessionId: string): Promise<void> {
    await this._client.unregisterClient(sessionId);
  }

  async getClient(sessionId: string): Promise<ClientDetail | undefined> {
    return this._client.getClient(sessionId);
  }

  async proxyMessage(ctx: Context, options: ProxyMessageOptions): Promise<void> {
    let body: string | unknown;
    const { detail, sessionId, type } = options;
    try {
      let encoding = 'utf-8';
      if (ctx.req.headers['content-type']) {
        const ct = contentType.parse(ctx.req.headers['content-type'] ?? '');
        if (ct.type !== 'application/json') {
          throw new Error(`Unsupported content-type: ${ct}`);
        }
        encoding = ct.parameters.charset;
      }

      // ctx.respond = false;

      body = await getRawBody(ctx.req, {
        limit: MAXIMUM_MESSAGE_SIZE,
        encoding,
      });
    } catch (error) {
      this.logger.error(error);
      ctx.res.writeHead(400).end(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: `Bad Request: ${String(error)}`,
        },
        id: null,
      }));
      return;
    }

    try {
      // const socketPath = `${this.app.baseDir}/mcpServer${pid}.sock`;
      let action: ProxyAction;
      switch (type) {
        case 'SSE': {
          action = 'MCP_SEE_PROXY';
          ctx.req.headers['mcp-proxy-type'] = action;
          ctx.req.headers['mcp-proxy-sessionid'] = sessionId;
          const resp = await fetch(`http://localhost:${detail.port}/mcp/message?sessionId=${sessionId}`, {
            // dispatcher: new Agent({
            //   connect: {
            //     socketPath,
            //   },
            // }),
            headers: ctx.req.headers as unknown as Record<string, string>,
            body: body as string,
            method: ctx.req.method,
          });
          const headers: Record<string, string> = {};
          for (const [ key, value ] of resp.headers.entries()) {
            if (IGNORE_HEADERS.includes(key)) {
              continue;
            }
            headers[key] = value;
          }
          ctx.set(headers);
          ctx.res.statusCode = resp.status;
          ctx.res.statusMessage = resp.statusText;
          const resData = await resp.text();
          ctx.body = resData;
          break;
        }
        case 'STDIO':
          action = 'MCP_STDIO_PROXY';
          ctx.req.headers['mcp-proxy-type'] = action;
          ctx.req.headers['mcp-proxy-sessionid'] = sessionId;
          ctx.res.writeHead(400).end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32602,
              message: 'Bad Request: STDIO IS NOT IMPL',
            },
            id: null,
          }));
          break;
        default: {
          action = 'MCP_STREAM_PROXY';
          ctx.respond = false;
          ctx.req.headers['mcp-proxy-type'] = action;
          ctx.req.headers['mcp-proxy-sessionid'] = sessionId;
          const response = await fetch(`http://localhost:${detail.port}`, {
            // dispatcher: new Agent({
            //   connect: {
            //     socketPath,
            //   },
            // }),
            headers: ctx.req.headers as unknown as Record<string, string>,
            method: ctx.req.method,
            ...(ctx.req.method !== 'GET' ? {
              body: body as string,
            } : {}),
          });
          const headers: Record<string, string> = {};
          for (const [ key, value ] of response.headers.entries()) {
            if (IGNORE_HEADERS.includes(key)) {
              continue;
            }
            headers[key] = value;
          }
          ctx.set(headers);
          ctx.res.statusCode = response.status;
          Readable.fromWeb(response.body!).pipe(ctx.res);
          break;
        }
      }
    } catch (error) {
      this.logger.error(error);
      // ctx.res.writeHead(400).end(`Invalid message: ${body}`);
      return;
    }
  }

  handleSseStream(ctx: Context, stream: ReadableStream<any>) {
    const processStream = async () => {
      try {
        const reader = stream
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          .pipeThrough(new TextDecoderStream())
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          .pipeThrough(new EventSourceParserStream())
          .getReader();

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value: event, done } = await reader.read();
          if (done) {
            break;
          }

          let eventData = 'event: message\n';

          if (event!.id) {
            eventData += `id: ${event!.id}\n`;
          }
          eventData += `data: ${JSON.stringify(event!.data)}\n\n`;

          ctx.res.write(eventData);
        }
        ctx.res.write('event: terminate');
      } catch (error) {
        ctx.res.statusCode = 500;
        ctx.res.write(`see stream error ${error}`);
        ctx.res.end();
      }
    };
    processStream();
  }

  get delegates() {
    return {
      registerClient: 'invoke',
      unregisterClient: 'invoke',
      getClient: 'invoke',
    };
  }

  get DataClient() {
    return MCPProxyDataClient;
  }

  get clusterOptions() {
    return {
      name: 'MCPProxy',
    };
  }
}
