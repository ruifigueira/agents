import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18798;
const BASE_URL = `http://localhost:${PORT}`;
const AGENT_NAME = "browser-test";
const PERSIST_DIR = path.join(__dirname, ".wrangler-browser-state");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessOnPort(port: number): void {
  try {
    const output = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`)
      .toString()
      .trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  } catch {
    // ignore
  }
}

function startWrangler(): ChildProcess {
  const configPath = path.join(__dirname, "wrangler.jsonc");
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--port",
      String(PORT),
      "--persist-to",
      PERSIST_DIR
    ],
    {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, NODE_ENV: "test" }
    }
  );

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler:err] ${line}`);
  });

  return child;
}

async function waitForReady(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.status > 0) return;
    } catch {
      // not ready
    }
    await sleep(delayMs);
  }
  throw new Error(`Wrangler did not start within ${maxAttempts * delayMs}ms`);
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    setTimeout(resolve, 3000);
  });
}

async function callAgent(
  method: string,
  args: unknown[] = []
): Promise<unknown> {
  const url = `${BASE_URL}/agents/browser-test-agent/${AGENT_NAME}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const id = crypto.randomUUID();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC call ${method} timed out after 30s`));
    }, 30_000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "rpc" && msg.id === id) {
          clearTimeout(timeout);
          ws.close();
          if (msg.success) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error || "RPC failed"));
          }
        }
      } catch {
        // ignore non-RPC messages
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("browser tools integration", () => {
  let wrangler: ChildProcess | null = null;

  beforeAll(async () => {
    killProcessOnPort(PORT);
    wrangler = startWrangler();
    await waitForReady();
  });

  afterAll(async () => {
    if (wrangler) {
      await killProcess(wrangler);
      wrangler = null;
    }
    killProcessOnPort(PORT);
    try {
      fs.rmSync(PERSIST_DIR, { recursive: true, force: true });
    } catch {
      // OK
    }
  });

  // ── Search tool tests ───────────────────────────────────────────

  describe("search", () => {
    it("should list CDP domain names", async () => {
      const result = (await callAgent("testSearch", [
        "async () => { const s = await spec.get(); return s.domains.map(d => d.name); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const domains = JSON.parse(result.text);
      expect(domains).toContain("Network");
      expect(domains).toContain("DOM");
      expect(domains).toContain("Page");
      expect(domains).toContain("Runtime");
      expect(domains).toContain("Browser");
    });

    it("should find specific commands in a domain", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          const network = s.domains.find(d => d.name === "Network");
          return network.commands.map(c => c.method);
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const methods = JSON.parse(result.text);
      expect(methods).toContain("Network.enable");
      expect(methods).toContain("Network.disable");
    });

    it("should return spec totals", async () => {
      const result = (await callAgent("testSearch", [
        `async () => {
          const s = await spec.get();
          return {
            domains: s.domains.length,
            commands: s.domains.reduce((n, d) => n + d.commands.length, 0)
          };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const totals = JSON.parse(result.text);
      expect(totals.domains).toBeGreaterThan(50);
      expect(totals.commands).toBeGreaterThan(600);
    });

    it("should handle code errors gracefully", async () => {
      const result = (await callAgent("testSearch", [
        "async () => { throw new Error('intentional test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("intentional test error");
    });
  });

  // ── Execute tool tests ──────────────────────────────────────────

  describe("execute", () => {
    it("should get browser version via CDP", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const version = JSON.parse(result.text);
      expect(version).toHaveProperty("product");
      expect(version).toHaveProperty("userAgent");
    });

    it("should list browser targets", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const { targetInfos } = await cdp.send("Target.getTargets");
          return targetInfos.map(t => ({ type: t.type, url: t.url }));
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const targets = JSON.parse(result.text);
      expect(Array.isArray(targets)).toBe(true);
    });

    it("should take screenshot via CDP", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await page.goto("data:text/html,<h1>Hello CDP</h1>");
          const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
          return { hasData: !!data, dataLength: data.length };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const screenshot = JSON.parse(result.text);
      expect(screenshot.hasData).toBe(true);
      expect(screenshot.dataLength).toBeGreaterThan(100);
    });

    it("should get DOM via CDP", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await page.goto("data:text/html,<h1>Hello CDP</h1>");
          const { root } = await cdp.send("DOM.getDocument");
          const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId: root.nodeId });
          return { html: outerHTML };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const dom = JSON.parse(result.text);
      expect(dom.html).toContain("Hello CDP");
    });

    it("should capture CDP events with cdp.on() callback", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          // Collect events via callback — this works because events are
          // dispatched locally in the sandbox via the stream-based bridge
          const events = [];
          cdp.on("Page.frameNavigated", (params) => {
            events.push(params);
          });
          await cdp.send("Page.enable");
          await page.goto("https://example.com");
          return {
            count: events.length,
            hasFrame: events.length > 0 && typeof events[0].frame === "object"
          };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.count).toBeGreaterThan(0);
      expect(data.hasFrame).toBe(true);
    });

    it("should handle CDP errors gracefully", async () => {
      const result = (await callAgent("testExecute", [
        'async () => { return await cdp.send("NonExistent.method"); }'
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
    });

    it("should handle code errors gracefully", async () => {
      const result = (await callAgent("testExecute", [
        "async () => { throw new Error('execute test error'); }"
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.text).toContain("execute test error");
    });

    // ── Sequential call tests ──────────────────────────────────────

    it("should handle multiple sequential execute calls", async () => {
      // First call - should succeed
      const result1 = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result1.isError).toBeFalsy();
      const version1 = JSON.parse(result1.text);
      expect(version1).toHaveProperty("product");

      // Second call - this is where the bug might manifest
      const result2 = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result2.isError).toBeFalsy();
      const version2 = JSON.parse(result2.text);
      expect(version2).toHaveProperty("product");

      // Third call for good measure
      const result3 = (await callAgent("testExecute", [
        'async () => { return await cdp.send("Browser.getVersion"); }'
      ])) as { text: string; isError?: boolean };

      expect(result3.isError).toBeFalsy();
      const version3 = JSON.parse(result3.text);
      expect(version3).toHaveProperty("product");
    });

    // ── Page method tests ──────────────────────────────────────────

    it("should navigate with page.goto()", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          const response = await page.goto("data:text/html,<h1>Hello Page</h1>");
          const url = await page.url();
          return { status: response.status, responseUrl: response.url, pageUrl: url };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const nav = JSON.parse(result.text);
      expect(nav.status).toBe(200);
      expect(nav.pageUrl).toContain("data:text/html");
    });

    it("should get page title and URL", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await page.goto("data:text/html,<title>Test Page</title><h1>Content</h1>");
          return { title: await page.title(), url: await page.url() };
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const info = JSON.parse(result.text);
      expect(info.title).toBe("Test Page");
      expect(info.url).toContain("data:text/html");
    });

    it("should capture accessibility snapshot as text", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await page.goto("data:text/html,<h1>Hello</h1><button>Click me</button><input type='text' placeholder='Enter name'>");
          const snapshot = await page.captureSnapshot({ format: "text" });
          return snapshot;
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      // Should contain multiple elements, not just the root
      expect(result.text).toContain("heading");
      expect(result.text).toContain("Hello");
      expect(result.text).toContain("button");
      expect(result.text).toContain("Click me");
      expect(result.text).toContain("textbox");
    });

    it("should capture accessibility snapshot as tree", async () => {
      const result = (await callAgent("testExecute", [
        `async () => {
          await page.goto("data:text/html,<h1>Hello</h1><button>Click me</button>");
          const tree = await page.captureSnapshot({ format: "tree" });
          return tree;
        }`
      ])) as { text: string; isError?: boolean };

      expect(result.isError).toBeFalsy();
      const tree = JSON.parse(result.text);
      expect(tree.role).toBe("RootWebArea");
      expect(tree.children.length).toBeGreaterThan(0);
    });
  });
});
