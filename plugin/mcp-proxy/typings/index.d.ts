import 'egg';
import '@eggjs/tegg-plugin';
import { MCPProxyApiClient } from '../index';

export { MCPProtocols } from '../index'

declare module 'egg' {
  export interface MCPProxyApp {
    mcpProxy: MCPProxyApiClient;
  }

  export interface Application extends MCPProxyApp {
  }
}
