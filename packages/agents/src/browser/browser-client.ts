/**
 * Browser client module — injected into the codemode sandbox as a JS module.
 *
 * This module connects to the CDP WebSocket via globalOutbound (CdpProxy).
 * All fetch() calls in the sandbox are routed through globalOutbound, so
 * fetch("http://cdp/", ...) goes to CdpProxy.fetch() which handles the
 * WebSocket upgrade and proxies to the real browser.
 *
 * Implements:
 *   - CDP command/event handling over WebSocket
 *   - Session attachment (Target.getTargets, Target.attachToTarget)
 *   - High-level page methods using raw CDP commands
 *   - Event support via local EventEmitter (cdp.on/once/off)
 *
 * The module is imported in the generated executor as:
 *   import { __init, page, cdp } from "browser-client.js";
 *   await __init();
 */

export const BROWSER_CLIENT_MODULE = `
// ── EventEmitter ──────────────────────────────────────────────────────
class EventEmitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    let list = this._handlers.get(event);
    if (!list) {
      list = [];
      this._handlers.set(event, list);
    }
    list.push(handler);
    return this;
  }

  off(event, handler) {
    const list = this._handlers.get(event);
    if (!list) return this;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  once(event, handler) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    const list = this._handlers.get(event);
    if (!list) return;
    // Copy so handlers can remove themselves
    for (const handler of [...list]) {
      handler(...args);
    }
  }
}

// ── WebSocket communication ───────────────────────────────────────────

let ws = null;
let nextId = 1;
const pending = new Map();
const cdpEmitter = new EventEmitter();
let pageSessionId = null;
const DEFAULT_TIMEOUT = 30000;

function cdpSend(method, params, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(\`CDP command timed out: \${method}\`));
    }, DEFAULT_TIMEOUT);

    pending.set(id, { resolve, reject, timer });

    const msg = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;

    ws.send(JSON.stringify(msg));
  });
}

function onMessage(event) {
  if (typeof event.data !== "string") return;
  
  try {
    const msg = JSON.parse(event.data);
    
    // Response to a pending command
    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.error) {
          const err = msg.error;
          p.reject(new Error(\`CDP error \${err.code ?? "unknown"}: \${err.message ?? "CDP error"}\`));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    
    // CDP event — emit to local handlers
    if (typeof msg.method === "string") {
      cdpEmitter.emit(msg.method, msg.params);
    }
  } catch {
    // ignore malformed messages
  }
}

function waitForEvent(event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdpEmitter.off(event, handler);
      reject(new Error(\`Timeout waiting for CDP event: \${event}\`));
    }, timeoutMs);

    const handler = (params) => {
      clearTimeout(timer);
      cdpEmitter.off(event, handler);
      resolve(params);
    };

    cdpEmitter.on(event, handler);
  });
}

// ── Session attachment ────────────────────────────────────────────────

async function attachToPage() {
  const result = await cdpSend("Target.getTargets");
  const pageTarget = result.targetInfos.find(t => t.type === "page");
  
  let targetId;
  if (!pageTarget) {
    // Create a new page target
    const created = await cdpSend("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
  } else {
    targetId = pageTarget.targetId;
  }
  
  const attached = await cdpSend("Target.attachToTarget", { targetId, flatten: true });
  pageSessionId = attached.sessionId;
  
  // Enable Page domain for navigation events
  await cdpSend("Page.enable", undefined, pageSessionId);
}

// ── CDP object ────────────────────────────────────────────────────────

export const cdp = {
  send(method, params) {
    // Route domain-scoped commands through the page session
    const domain = method.split(".")[0] || "";
    const needsSession = !["Browser", "Target"].includes(domain);
    const sessionId = needsSession ? pageSessionId : undefined;
    return cdpSend(method, params, sessionId);
  },
  on(event, handler) {
    cdpEmitter.on(event, handler);
    return cdp;
  },
  off(event, handler) {
    cdpEmitter.off(event, handler);
    return cdp;
  },
  once(event, handler) {
    cdpEmitter.once(event, handler);
    return cdp;
  }
};

// ── Page object ───────────────────────────────────────────────────────

export const page = {
  async goto(url, options) {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    
    // Navigate
    const nav = await cdpSend("Page.navigate", { url }, pageSessionId);
    if (nav.errorText) {
      throw new Error(\`Navigation failed: \${nav.errorText}\`);
    }
    
    // Wait for load event
    await waitForEvent("Page.loadEventFired", timeout);
    
    return { status: 200, url };
  },

  async url() {
    const result = await cdpSend(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      pageSessionId
    );
    return String(result.result.value);
  },

  async title() {
    const result = await cdpSend(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      pageSessionId
    );
    return String(result.result.value);
  },

  async content() {
    const result = await cdpSend(
      "Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true },
      pageSessionId
    );
    return String(result.result.value);
  },

  async click(selector, options) {
    const { type, value } = parseSelector(selector);
    let x, y;

    if (type === "uid") {
      // Query the accessibility tree for this specific node
      const axResult = await cdpSend("Accessibility.getFullAXTree", {}, pageSessionId);
      const axNode = axResult.nodes.find(n => n.nodeId === value);
      
      if (!axNode) {
        throw new Error(\`Accessibility node not found: \${value}\`);
      }
      if (!axNode.backendDOMNodeId) {
        throw new Error(\`Node \${value} has no backendDOMNodeId (may be a virtual node)\`);
      }

      // Get the content quads (bounding coordinates) for the DOM node
      const quadsResult = await cdpSend(
        "DOM.getContentQuads",
        { backendNodeId: axNode.backendDOMNodeId },
        pageSessionId
      );

      if (!quadsResult.quads || quadsResult.quads.length === 0) {
        throw new Error(\`Node \${value} has no visible content quads\`);
      }

      // Calculate center of the first quad
      // Quads are arrays of 8 numbers: [x1,y1, x2,y2, x3,y3, x4,y4]
      const quad = quadsResult.quads[0];
      x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    } else {
      // CSS selector - find element and get its center coordinates
      const boxResult = await cdpSend(
        "Runtime.evaluate",
        {
          expression: \`(() => {
            const el = document.querySelector(\${JSON.stringify(value)});
            if (!el) throw new Error("Element not found: \${value}");
            const rect = el.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()\`,
          returnByValue: true,
          awaitPromise: true
        },
        pageSessionId
      );

      if (boxResult.exceptionDetails) {
        throw new Error(boxResult.exceptionDetails.text);
      }

      ({ x, y } = boxResult.result.value);
    }

    // Dispatch mouse events
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, pageSessionId);
    await cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, pageSessionId);
    await cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, pageSessionId);

    return { clicked: selector };
  },

  async type(selector, text, options) {
    const { type, value } = parseSelector(selector);

    if (type === "uid") {
      // Query the accessibility tree for this specific node
      const axResult = await cdpSend("Accessibility.getFullAXTree", {}, pageSessionId);
      const axNode = axResult.nodes.find(n => n.nodeId === value);
      
      if (!axNode) {
        throw new Error(\`Accessibility node not found: \${value}\`);
      }
      if (!axNode.backendDOMNodeId) {
        throw new Error(\`Node \${value} has no backendDOMNodeId (may be a virtual node)\`);
      }

      // Focus the element using DOM.focus with backendNodeId
      await cdpSend("DOM.focus", { backendNodeId: axNode.backendDOMNodeId }, pageSessionId);
    } else {
      // CSS selector - focus the element via Runtime.evaluate
      const result = await cdpSend(
        "Runtime.evaluate",
        {
          expression: \`(() => {
            const el = document.querySelector(\${JSON.stringify(value)});
            if (!el) throw new Error("Element not found: \${value}");
            el.focus();
          })()\`,
          returnByValue: true,
          awaitPromise: true
        },
        pageSessionId
      );

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text);
      }
    }

    // Insert text
    await cdpSend("Input.insertText", { text }, pageSessionId);

    return { typed: text.length };
  },

  async screenshot(options) {
    const format = options?.format ?? "png";
    const result = await cdpSend("Page.captureScreenshot", { format }, pageSessionId);
    return { data: result.data };
  },

  async captureSnapshot(options) {
    const format = options?.format ?? "tree";
    const interestingOnly = options?.interestingOnly ?? true;
    const compact = options?.compact ?? false;

    const result = await cdpSend("Accessibility.getFullAXTree", {}, pageSessionId);

    // Build a tree from the flat node list
    const tree = buildAXTree(result.nodes, interestingOnly, compact);

    if (format === "text") {
      return formatAXTree(tree);
    }
    return tree;
  },

  async evaluate(fn, ...args) {
    const argsStr = args.length > 0 ? args.map(a => JSON.stringify(a)).join(",") : "";
    const expression = \`(\${fn})(\${argsStr})\`;

    const result = await cdpSend(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      pageSessionId
    );

    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(\`Evaluation failed: \${desc}\`);
    }

    return result.result.value;
  },

  async waitForSelector(selector, options) {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const interval = 100;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = await cdpSend(
        "Runtime.evaluate",
        {
          expression: \`!!document.querySelector(\${JSON.stringify(selector)})\`,
          returnByValue: true
        },
        pageSessionId
      );

      if (result.result.value) {
        return { found: selector };
      }

      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(\`Timeout waiting for selector: \${selector}\`);
  }
};

// ── Selector parsing ──────────────────────────────────────────────────

function parseSelector(selector) {
  if (selector.startsWith("uid=")) {
    return { type: "uid", value: selector.slice(4) };
  }
  return { type: "css", value: selector };
}

// ── Accessibility tree helpers ────────────────────────────────────────

function buildAXTree(nodes, interestingOnly, compact) {
  if (nodes.length === 0) return null;

  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Convert a node and its children, returning either:
  // - A single node object
  // - An array of children (if this node should be skipped/flattened)
  // - null (if nothing interesting)
  function convert(node) {
    const role = node.role?.value ?? "none";
    const isIgnored = node.ignored === true;
    const isUninteresting = role === "none" || role === "generic";
    
    // In compact mode, skip InlineTextBox nodes (text fragments inside elements)
    if (compact && role === "InlineTextBox") {
      return null;
    }
    
    // Recursively process children first
    const children = [];
    if (node.childIds) {
      for (const childId of node.childIds) {
        // Skip invalid/placeholder child IDs (like -1000000002)
        if (typeof childId === "string" && childId.startsWith("-")) continue;
        
        const child = nodeMap.get(childId);
        if (child) {
          const converted = convert(child);
          if (converted) {
            // If convert returned an array, flatten it into children
            if (Array.isArray(converted)) {
              children.push(...converted);
            } else {
              children.push(converted);
            }
          }
        }
      }
    }

    // Skip ignored nodes but keep their children
    if (interestingOnly && isIgnored) {
      return children.length > 0 ? children : null;
    }

    // Skip uninteresting wrapper nodes with no name/value
    if (interestingOnly && isUninteresting && !node.name?.value && !node.value?.value) {
      return children.length > 0 ? children : null;
    }

    // Flatten properties array into an object
    let properties;
    if (node.properties && node.properties.length > 0) {
      properties = {};
      for (const prop of node.properties) {
        properties[prop.name] = prop.value.value;
      }
    }

    return {
      nodeId: node.nodeId,
      backendDOMNodeId: node.backendDOMNodeId,
      role,
      name: node.name?.value,
      value: node.value?.value,
      description: node.description?.value,
      properties,
      children
    };
  }

  const result = convert(nodes[0]);
  // If the root was flattened to an array, wrap it in a synthetic root
  if (Array.isArray(result)) {
    return {
      nodeId: nodes[0].nodeId,
      role: nodes[0].role?.value ?? "RootWebArea",
      name: nodes[0].name?.value,
      children: result
    };
  }
  return result;
}

function formatAXTree(node, depth = 0) {
  if (!node) return "";

  const chunks = [];
  const indent = " ".repeat(depth * 2);
  const attrs = [];

  // uid for click("uid=X") reference (matches chrome-devtools-mcp format)
  attrs.push(\`uid=\${node.nodeId}\`);

  // Role
  if (node.role) {
    attrs.push(node.role === "none" ? "ignored" : node.role);
  }

  // Name in quotes
  if (node.name) {
    attrs.push(\`"\${node.name}"\`);
  }

  // Value
  if (node.value !== undefined && node.value !== "") {
    attrs.push(\`value="\${node.value}"\`);
  }

  // Description
  if (node.description) {
    attrs.push(\`description="\${node.description}"\`);
  }

  // Boolean properties with their "ability" counterparts
  const booleanPropertyMap = {
    disabled: "disableable",
    expanded: "expandable",
    focused: "focusable",
    selected: "selectable"
  };

  if (node.properties) {
    const sortedKeys = Object.keys(node.properties).sort();
    for (const key of sortedKeys) {
      const value = node.properties[key];

      // Add the "ability" property if this is a boolean property
      const abilityProp = booleanPropertyMap[key];
      if (abilityProp && value !== undefined) {
        attrs.push(abilityProp);
      }

      // Add the property itself
      if (value === true) {
        attrs.push(key);
      } else if (typeof value === "string" || typeof value === "number") {
        attrs.push(\`\${key}="\${value}"\`);
      }
    }
  }

  chunks.push(indent + attrs.join(" ") + "\\n");

  for (const child of node.children) {
    chunks.push(formatAXTree(child, depth + 1));
  }

  return chunks.join("");
}

// ── Init ──────────────────────────────────────────────────────────────

export async function __init() {
  // Already initialized - reuse existing connection
  // This allows the same dynamic worker to handle multiple execute() calls
  if (ws) return;

  // Connect to the browser via globalOutbound (CdpProxy)
  // All fetch() calls in the sandbox are routed through globalOutbound
  const response = await fetch("http://cdp/", {
    headers: { Upgrade: "websocket" }
  });

  if (!response.webSocket) {
    console.error("[browser-client] fetch response status:", response.status);
    console.error("[browser-client] fetch response headers:", Object.fromEntries(response.headers.entries()));
    const text = await response.text().catch(() => "(no body)");
    console.error("[browser-client] fetch response body:", text);
    throw new Error("Failed to establish WebSocket connection to browser: " + text);
  }

  ws = response.webSocket;
  ws.accept();
  ws.addEventListener("message", onMessage);

  // Attach to a page target
  await attachToPage();
}
`;
