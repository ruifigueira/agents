/**
 * CDP Proxy — a WorkerEntrypoint that provides scoped CDP WebSocket access.
 *
 * Users export this from their worker, then use ctx.exports.CdpProxy({ props })
 * to create a capability-scoped Fetcher that only allows WebSocket connections
 * to a specific browser session.
 *
 * Architecture:
 * 1. User's worker exports CdpProxy (re-exported from agents/browser)
 * 2. Host creates browser session via Browser Rendering binding
 * 3. Host creates stub: ctx.exports.CdpProxy({ props: { sessionId } })
 * 4. Stub is passed as globalOutbound to the sandbox executor
 * 5. Sandbox calls fetch("http://cdp/", { Upgrade: "websocket" })
 * 6. CdpProxy.fetch() forwards to browser binding for the locked session
 *
 * @example
 * ```ts
 * // In your worker's main module (index.ts):
 * export { CdpProxy } from "agents/browser";
 *
 * // In your Agent or handler:
 * const sessionId = await createBrowserSession(env.BROWSER);
 * const cdpProxy = ctx.exports.CdpProxy({ props: { sessionId } });
 *
 * const executor = new DynamicWorkerExecutor({
 *   loader: env.LOADER,
 *   globalOutbound: cdpProxy
 * });
 * ```
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { createBrowserSession } from "./cdp-session";

// ── Types ────────────────────────────────────────────────────────────

export interface CdpProxyEnv {
  /** Browser Rendering binding (Fetcher) — required for production */
  BROWSER?: Fetcher;
}

export interface CdpProxyProps {
  /** The browser session ID to proxy (for Browser Rendering binding) */
  sessionId?: string;
  /** CDP base URL for local dev (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests */
  cdpHeaders?: Record<string, string>;
}

// ── CdpProxy WorkerEntrypoint ────────────────────────────────────────

const LOCALHOST_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]"
]);

/**
 * WorkerEntrypoint that proxies CDP WebSocket connections.
 *
 * Supports two modes:
 * 1. Browser Rendering binding (production): Pass `sessionId` prop
 * 2. CDP URL (local dev): Pass `cdpUrl` prop
 *
 * Export this from your worker's main module, then use ctx.exports.CdpProxy
 * to create capability-scoped Fetcher stubs.
 *
 * @example
 * ```ts
 * // worker/index.ts
 * export { CdpProxy } from "agents/browser";
 *
 * // Production: Browser Rendering binding
 * const cdpProxy = ctx.exports.CdpProxy({ props: { sessionId } });
 *
 * // Local dev: CDP URL
 * const cdpProxy = ctx.exports.CdpProxy({ props: { cdpUrl: "http://localhost:9222" } });
 * ```
 */
export class CdpProxy extends WorkerEntrypoint<CdpProxyEnv, CdpProxyProps> {
  /**
   * Handle fetch requests — only allows WebSocket upgrades to the CDP endpoint.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Only handle requests to the "cdp" host
    if (url.hostname !== "cdp") {
      return new Response("Not found", { status: 404 });
    }

    // Only WebSocket upgrades allowed
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Only WebSocket connections supported", {
        status: 400
      });
    }

    const props = this.ctx.props;

    // Mode 1: Browser Rendering binding (production)
    if (props?.sessionId) {
      const browser = this.env.BROWSER;
      if (!browser) {
        console.error(
          "[CdpProxy] BROWSER binding not found in env. Available keys:",
          Object.keys(this.env)
        );
        return new Response("Browser binding not configured", { status: 500 });
      }

      try {
        const response = await browser.fetch(
          `http://localhost/v1/devtools/browser/${props.sessionId}`,
          { headers: { Upgrade: "websocket" } }
        );
        if (!response.webSocket) {
          console.error(
            "[CdpProxy] browser.fetch returned response without webSocket. Status:",
            response.status
          );
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[CdpProxy] browser.fetch error:", message);
        return new Response(`CDP connection failed: ${message}`, {
          status: 502
        });
      }
    }

    // Mode 2: CDP URL (local dev)
    if (props?.cdpUrl) {
      try {
        const wsUrl = await this.#discoverWebSocketUrl(
          props.cdpUrl,
          props.cdpHeaders
        );
        const response = await fetch(wsUrl, {
          headers: { Upgrade: "websocket" }
        });
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`CDP connection failed: ${message}`, {
          status: 502
        });
      }
    }

    return new Response(
      "Either sessionId or cdpUrl must be provided in props",
      { status: 500 }
    );
  }

  /**
   * Discover the WebSocket debugger URL from a CDP base URL.
   */
  async #discoverWebSocketUrl(
    baseUrl: string,
    headers?: Record<string, string>
  ): Promise<string> {
    const endpoint = new URL("/json/version", baseUrl).toString();
    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      throw new Error(
        `Failed to discover CDP endpoint at ${endpoint}: ${response.status}`
      );
    }

    const payload = (await response.json()) as {
      webSocketDebuggerUrl?: string;
    };
    if (!payload.webSocketDebuggerUrl) {
      throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
    }

    let wsUrl = payload.webSocketDebuggerUrl;
    const parsed = new URL(wsUrl);
    if (LOCALHOST_HOSTS.has(parsed.hostname)) {
      const base = new URL(baseUrl);
      parsed.hostname = base.hostname;
      parsed.port = base.port;
    }
    // Workers runtime requires fetch + Upgrade header for outbound WebSockets
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return parsed.toString();
  }
}

// ── CdpSessionManager ────────────────────────────────────────────────

export interface CdpSessionManagerOptions {
  /** Browser Rendering binding (Fetcher) — required for production */
  browser?: Fetcher;
  /** CDP base URL for local dev (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests */
  cdpHeaders?: Record<string, string>;
  /**
   * ctx.exports object from the parent worker.
   * Must have CdpProxy exported from the worker's main module.
   */
  exports: {
    CdpProxy: (options: { props: CdpProxyProps }) => Fetcher;
  };
}

/**
 * Manages browser session creation and provides capability-scoped CDP proxy.
 *
 * Supports two modes:
 * 1. Browser Rendering binding (production): Pass `browser`
 * 2. CDP URL (local dev): Pass `cdpUrl`
 *
 * @example
 * ```ts
 * // Production
 * const sessionManager = new CdpSessionManager({
 *   browser: env.BROWSER,
 *   exports: ctx.exports
 * });
 *
 * // Local dev
 * const sessionManager = new CdpSessionManager({
 *   cdpUrl: "http://localhost:9222",
 *   exports: ctx.exports
 * });
 *
 * // Get a proxy Fetcher for the current session
 * const cdpProxy = await sessionManager.getProxy();
 *
 * // Pass to executor as globalOutbound
 * const executor = new DynamicWorkerExecutor({
 *   loader: env.LOADER,
 *   globalOutbound: cdpProxy
 * });
 * ```
 */
export class CdpSessionManager {
  #browser: Fetcher | undefined;
  #cdpUrl: string | undefined;
  #cdpHeaders: Record<string, string> | undefined;
  #exports: CdpSessionManagerOptions["exports"];
  #sessionId: string | undefined;

  constructor(options: CdpSessionManagerOptions) {
    this.#browser = options.browser;
    this.#cdpUrl = options.cdpUrl;
    this.#cdpHeaders = options.cdpHeaders;
    this.#exports = options.exports;

    if (!options.browser && !options.cdpUrl) {
      throw new Error(
        "CdpSessionManager requires either 'browser' or 'cdpUrl'"
      );
    }
  }

  /**
   * Get the cached session ID (if any).
   * Only applicable when using Browser Rendering binding.
   */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /**
   * Set the session ID (for reusing across executions).
   */
  set sessionId(id: string | undefined) {
    this.#sessionId = id;
  }

  /**
   * Get or create a browser session.
   * Only applicable when using Browser Rendering binding.
   */
  async getOrCreateSession(): Promise<string | undefined> {
    // For cdpUrl mode, there's no session management
    if (!this.#browser) {
      return undefined;
    }

    if (this.#sessionId) {
      return this.#sessionId;
    }
    const sessionId = await createBrowserSession(this.#browser);
    this.#sessionId = sessionId;
    return sessionId;
  }

  /**
   * Get a CDP proxy Fetcher for the current session.
   *
   * For Browser Rendering binding: Creates the session if needed, then returns
   * a capability-scoped Fetcher that only allows CDP WebSocket connections to
   * that specific session.
   *
   * For cdpUrl: Returns a Fetcher that connects to the local Chrome URL.
   *
   * Pass this as `globalOutbound` to the executor.
   */
  async getProxy(): Promise<Fetcher> {
    // Browser Rendering binding mode
    if (this.#browser) {
      const sessionId = await this.getOrCreateSession();
      return this.#exports.CdpProxy({ props: { sessionId } });
    }

    // CDP URL mode (local dev)
    return this.#exports.CdpProxy({
      props: {
        cdpUrl: this.#cdpUrl,
        cdpHeaders: this.#cdpHeaders
      }
    });
  }

  /**
   * Clear the cached session ID.
   */
  clearSession(): void {
    this.#sessionId = undefined;
  }
}

// ── Legacy exports ───────────────────────────────────────────────────

/**
 * @deprecated Use `new CdpSessionManager(options)` instead.
 */
export function createCdpProxyFetcher(options: CdpSessionManagerOptions) {
  const manager = new CdpSessionManager(options);
  return {
    getOrCreateSession: () => manager.getOrCreateSession(),
    getProxy: () => manager.getProxy(),
    get sessionId() {
      return manager.sessionId;
    },
    set sessionId(id: string | undefined) {
      manager.sessionId = id;
    },
    clearSession: () => manager.clearSession()
  };
}
