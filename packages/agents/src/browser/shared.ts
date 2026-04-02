import type { ResolvedProvider } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { BROWSER_CLIENT_MODULE } from "./browser-client";
import { truncateResponse } from "./truncate";
import { CdpSessionManager, type CdpProxyProps } from "./cdp-proxy";
import spec from "./data/cdp/spec.json";
import summary from "./data/cdp/summary.json";
import { CDP_DOMAINS } from "./data/cdp/domains";

export interface BrowserToolsOptions {
  /** Browser Rendering binding (Fetcher) — required for production */
  browser?: Fetcher;
  /** CDP base URL (e.g. http://localhost:9222) — used for local dev */
  cdpUrl?: string;
  /** Headers to send with CDP URL discovery requests (e.g. Access headers) */
  cdpHeaders?: Record<string, string>;
  /** Worker loader for code execution */
  loader: WorkerLoader;
  /**
   * ctx.exports from the parent worker.
   * Must have CdpProxy exported from the worker's main module.
   */
  exports: {
    CdpProxy: (options: { props: CdpProxyProps }) => Fetcher;
  };
  /** Execution timeout in ms */
  timeout?: number;
}

export const SEARCH_DESCRIPTION = `Search the Chrome DevTools Protocol spec using JavaScript code.

Source totals: ${summary.totals.domains} domains, ${summary.totals.commands} commands, ${summary.totals.events} events, ${summary.totals.types} types.
Top domains: ${CDP_DOMAINS.slice(0, 20).join(", ")}...

Available in your code:

declare const spec: {
  get(): Promise<{
    domains: Array<{
      name: string;
      description?: string;
      commands: Array<{ name: string; method: string; description?: string }>;
      events: Array<{ name: string; event: string; description?: string }>;
      types: Array<{ id: string; name: string; description?: string }>;
    }>;
  }>;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.

Example:
async () => {
  const s = await spec.get();
  return s.domains
    .find(d => d.name === "Network")
    .commands.filter(c => c.description?.toLowerCase().includes("intercept"))
    .map(c => ({ method: c.method, description: c.description }));
}`;

export const EXECUTE_DESCRIPTION = `Execute browser automation code using page and CDP APIs.

This tool runs JavaScript code in a sandboxed environment with access to:

- \`page\` - High-level page API (recommended for most tasks)
- \`cdp\` - Chrome DevTools Protocol with full event support

Both share the same browser session. Use \`page\` for common tasks like navigation,
clicking, and screenshots. Use \`cdp\` when you need direct protocol access or events.

IMPORTANT: You must write an async arrow function. Do NOT call page or cdp as separate tools.

## Page examples (recommended)

Use the \`page\` object for high-level browser automation. All examples below are 
complete async arrow functions ready to use.

### Navigate and get page info
async () => {
  await page.goto("https://example.com");
  return { title: await page.title(), url: await page.url() };
}

### Click an element
async () => {
  await page.click("button.submit");
  return { clicked: true };
}

### Fill a form
async () => {
  await page.type("#email", "user@example.com");
  await page.type("#password", "secret");
  await page.click("button[type=submit]");
  return { submitted: true };
}

### Take a screenshot (returns base64)
async () => {
  const screenshot = await page.screenshot({ format: "png" });
  return { screenshot };
}

### Capture accessibility snapshot for analysis (use format: "text")
async () => {
  // Use format: "text" when you need to READ/ANALYZE the page structure
  // Returns human-readable text with node IDs (uid=X) for clicking
  const snapshot = await page.captureSnapshot({ format: "text" });
  return snapshot;
}
// Example output (matches chrome-devtools-mcp format):
// uid=1 RootWebArea "Example Domain"
//   uid=4 heading "Example Domain"
//   uid=5 link "More information..." focusable
//   uid=6 textbox "Search" focusable focused value="hello"

### Click element by accessibility node ID
async () => {
  // First get text snapshot to see what's on the page
  const snapshot = await page.captureSnapshot({ format: "text" });
  console.log(snapshot); // See available elements with uid=X
  
  // Then click by uid (e.g., uid=5 from the snapshot above)
  await page.click("uid=5");
  return { clicked: true };
}

### Capture structured tree (for programmatic traversal)
async () => {
  // Use default format: "tree" when you need to TRAVERSE programmatically
  const tree = await page.captureSnapshot();
  // tree has: nodeId, backendDOMNodeId, role, name, value, properties, children
  function findNode(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const button = findNode(tree, n => n.role === "button" && n.name === "Submit");
  return button ? { nodeId: button.nodeId, name: button.name } : null;
}

### Evaluate JavaScript on the page
async () => {
  const text = await page.evaluate("() => document.body.innerText");
  return text;
}

### Get page content
async () => {
  const html = await page.content();
  return html.slice(0, 1000); // truncate for readability
}

### Wait for an element
async () => {
  await page.waitForSelector(".loaded");
  return { ready: true };
}

## CDP examples (advanced)

Use cdp.send() when you need low-level control not available in page API.
Use cdp.on() to listen for CDP events with real callbacks.

IMPORTANT: If you don't know the exact CDP method, call browser_search first.

### Get browser version via CDP
async () => {
  const version = await cdp.send("Browser.getVersion");
  return version;
}

### Take screenshot via CDP
async () => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  return { data };
}

### Monitor network requests with CDP events
async () => {
  const responses = [];
  cdp.on("Network.responseReceived", (params) => {
    responses.push({ url: params.response.url, status: params.response.status });
  });
  await cdp.send("Network.enable");
  await page.goto("https://example.com");
  await new Promise(r => setTimeout(r, 1000)); // Wait for responses
  return { count: responses.length, responses: responses.slice(0, 5) };
}

### Wait for a specific CDP event
async () => {
  await cdp.send("Page.enable");
  const loaded = new Promise(resolve => {
    cdp.once("Page.loadEventFired", resolve);
  });
  cdp.send("Page.navigate", { url: "https://example.com" });
  const params = await loaded;
  return { timestamp: params.timestamp };
}

## API Reference

interface AXTreeNode {
  nodeId: string;           // Use with click("uid=X") or type("uid=X", ...)
  backendDOMNodeId?: number;
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  properties?: Record<string, unknown>;
  children: AXTreeNode[];
}

declare const page: {
  goto(url: string, options?: object): Promise<{ status: number; url: string } | null>;
  /**
   * Click an element by selector.
   * - CSS selector: click("button.submit")
   * - Accessibility uid: click("uid=5") — use uid from captureSnapshot({ format: "text" })
   */
  click(selector: string, options?: object): Promise<{ clicked: string }>;
  /**
   * Type text into an element.
   * - CSS selector: type("input[name=email]", "test@example.com")
   * - Accessibility uid: type("uid=5", "test@example.com")
   */
  type(selector: string, text: string, options?: object): Promise<{ typed: number }>;
  screenshot(options?: object): Promise<{ data: string }>;
  /**
   * Capture accessibility snapshot.
   * - format: "text" — human-readable with node IDs, use for READING/ANALYZING page
   * - format: "tree" (default) — structured object, use for PROGRAMMATIC traversal
   * - compact: true — also filter out InlineTextBox nodes (text fragments) for smaller output
   */
  captureSnapshot(options?: { format?: "tree" | "text"; interestingOnly?: boolean; compact?: boolean }): Promise<AXTreeNode | string>;
  evaluate(fn: string, ...args: unknown[]): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): Promise<string>;
  waitForSelector(selector: string, options?: object): Promise<{ found: string }>;
};

declare const cdp: {
  /** Send a CDP command */
  send(method: string, params?: unknown): Promise<unknown>;
  /** Register an event listener for CDP events */
  on(event: string, handler: (params: unknown) => void): cdp;
  /** Register a one-time event listener */
  once(event: string, handler: (params: unknown) => void): cdp;
  /** Remove an event listener */
  off(event: string, handler: (params: unknown) => void): cdp;
};

Write an async arrow function in JavaScript. Do NOT use TypeScript syntax.`;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

let didWarnExperimental = false;

/**
 * Create browser tool handlers for search and execute operations.
 *
 * IMPORTANT: Cache the returned handler instance to enable browser session reuse.
 * Each call to createBrowserToolHandlers() creates a new session cache scope.
 *
 * @example
 * ```ts
 * // In your worker's main module, export CdpProxy:
 * export { CdpProxy } from "agents/browser";
 *
 * class MyAgent extends Agent<Env> {
 *   #browserTools?: ReturnType<typeof createBrowserToolHandlers>;
 *
 *   getBrowserTools() {
 *     this.#browserTools ??= createBrowserToolHandlers({
 *       browser: this.env.BROWSER,
 *       loader: this.env.LOADER,
 *       exports: this.ctx.exports
 *     });
 *     return this.#browserTools;
 *   }
 * }
 * ```
 */
export function createBrowserToolHandlers(options: BrowserToolsOptions) {
  if (!didWarnExperimental) {
    didWarnExperimental = true;
    console.warn(
      "[agents/browser] Browser tools are experimental and may change in a future release."
    );
  }

  // Search executor - no globalOutbound needed, just queries the spec
  const searchExecutor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout
  });
  const specData = spec;

  // Session manager handles browser session creation and CdpProxy creation
  const sessionManager = new CdpSessionManager({
    browser: options.browser,
    cdpUrl: options.cdpUrl,
    cdpHeaders: options.cdpHeaders,
    exports: options.exports
  });

  // Execute executor - created lazily on first call, reused across calls
  let executeExecutor: DynamicWorkerExecutor | undefined;

  async function search(code: string): Promise<ToolResult> {
    try {
      const providers: ResolvedProvider[] = [
        {
          name: "spec",
          fns: { get: async () => specData }
        }
      ];
      const result = await searchExecutor.execute(code, providers);
      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return { text: formatError(error), isError: true };
    }
  }

  async function execute(code: string): Promise<ToolResult> {
    try {
      // Create executor lazily on first call, reuse for subsequent calls.
      // The same CdpProxy stub and browser session are reused across calls.
      if (!executeExecutor) {
        const cdpProxy = await sessionManager.getProxy();
        executeExecutor = new DynamicWorkerExecutor({
          loader: options.loader,
          globalOutbound: cdpProxy,
          timeout: options.timeout,
          modules: { "browser-client.js": BROWSER_CLIENT_MODULE },
          imports: {
            "browser-client.js": { globals: ["page", "cdp"], init: "__init" }
          }
        });
      }

      const result = await executeExecutor.execute(code, []);

      if (result.error) {
        return { text: result.error, isError: true };
      }
      return { text: truncateResponse(result.result) };
    } catch (error) {
      return { text: formatError(error), isError: true };
    }
  }

  return { search, execute };
}
