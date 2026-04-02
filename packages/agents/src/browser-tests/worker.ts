import { Agent, callable, routeAgentRequest } from "agents";
import { createBrowserToolHandlers, type ToolResult } from "../browser/shared";
import type { CdpProxyProps } from "../browser/cdp-proxy";

// Re-export CdpProxy so it's available via ctx.exports
export { CdpProxy } from "../browser/cdp-proxy";

type Env = {
  BROWSER: Fetcher;
  LOADER: WorkerLoader;
  CDP_BASE_URL: string;
  BrowserTestAgent: DurableObjectNamespace<BrowserTestAgent>;
};

export class BrowserTestAgent extends Agent<Env> {
  // Cache the handler instance to enable browser session reuse across calls
  #handlers?: ReturnType<typeof createBrowserToolHandlers>;

  #getHandlers() {
    // @ts-expect-error — ctx.exports is experimental
    const exports = this.ctx.exports as {
      CdpProxy: (options: { props: CdpProxyProps }) => Fetcher;
    };

    this.#handlers ??= createBrowserToolHandlers({
      browser: this.env.BROWSER,
      cdpUrl: this.env.CDP_BASE_URL || undefined,
      loader: this.env.LOADER,
      exports
    });
    return this.#handlers;
  }

  @callable()
  async testSearch(code: string): Promise<ToolResult> {
    return this.#getHandlers().search(code);
  }

  @callable()
  async testExecute(code: string): Promise<ToolResult> {
    return this.#getHandlers().execute(code);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
