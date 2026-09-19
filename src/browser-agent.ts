import { acquire, endpointURLString, limits, sessions, type BrowserWorker } from "@cloudflare/playwright";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpAgent } from "agents/mcp";

// @cloudflare/playwright-mcp@0.0.5 only exports createMcpAgent(), which hard-codes
// a CDP endpoint without a Browser Run session id. Import its connection builder
// in one isolated adapter so this Durable Object can reconnect to a persisted
// Browser Run session instead of launching a new browser on every wake.
// Keep this path pinned to the package version in package.json.
// @ts-expect-error Internal adapter for the pinned package version.
import { createConnection } from "../node_modules/@cloudflare/playwright-mcp/lib/esm/src/index.js";

const SESSION_STORAGE_KEY = "browser-run-session";
const BROWSER_KEEP_ALIVE_MS = 120_000;

interface BrowserAgentEnv {
  BROWSER: BrowserWorker;
}

interface BrowserSessionRecord {
  sessionId: string;
  acquiredAt: number;
}

interface BrowserAgentProps extends Record<string, unknown> {
  userId: string;
  scopes: string[];
}

function isRateLimitError(error: unknown): boolean {
  const message = String(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit");
}

interface BrowserLimitsWithUsage {
  activeSessions: Array<{ id: string }>;
  maxConcurrentSessions: number;
  allowedBrowserAcquisitions: number;
  timeUntilNextAllowedBrowserAcquisition: number;
  usedBrowserTimeSeconds?: number;
}

async function storedActiveSession(
  storage: DurableObjectStorage,
  browser: BrowserWorker,
): Promise<BrowserSessionRecord | undefined> {
  const record =
    await storage.get<BrowserSessionRecord>(SESSION_STORAGE_KEY);

  if (!record?.sessionId) {
    return undefined;
  }

  try {
    const active = await sessions(browser);
    if (active.some((session) => session.sessionId === record.sessionId)) {
      return record;
    }

    await storage.delete(SESSION_STORAGE_KEY);
    return undefined;
  } catch {
    // If session enumeration itself is temporarily unavailable, prefer
    // reconnecting to the known session over creating a duplicate browser.
    return record;
  }
}

async function adoptReusableSession(
  storage: DurableObjectStorage,
  browser: BrowserWorker,
): Promise<BrowserSessionRecord | undefined> {
  try {
    const active = await sessions(browser);
    const reusable = active
      .filter((session) => !session.connectionId)
      .sort((a, b) => b.startTime - a.startTime)[0];

    if (!reusable) {
      return undefined;
    }

    const record = {
      sessionId: reusable.sessionId,
      acquiredAt: reusable.startTime,
    };
    await storage.put(SESSION_STORAGE_KEY, record);
    return record;
  } catch {
    return undefined;
  }
}

async function acquireBrowserSession(
  storage: DurableObjectStorage,
  browser: BrowserWorker,
): Promise<BrowserSessionRecord> {
  try {
    const { sessionId } = await acquire(browser, {
      keep_alive: BROWSER_KEEP_ALIVE_MS,
    });
    const record = { sessionId, acquiredAt: Date.now() };
    await storage.put(SESSION_STORAGE_KEY, record);
    return record;
  } catch (error) {
    if (!isRateLimitError(error)) {
      throw error;
    }

    let currentLimits: BrowserLimitsWithUsage | undefined;
    try {
      currentLimits = (await limits(browser)) as BrowserLimitsWithUsage;
    } catch {
      throw error;
    }

    if (
      currentLimits.activeSessions.length >=
      currentLimits.maxConcurrentSessions
    ) {
      throw new Error(
        `Cloudflare Browser Run concurrent-session limit reached (${currentLimits.activeSessions.length}/${currentLimits.maxConcurrentSessions}).`,
      );
    }

    if (currentLimits.allowedBrowserAcquisitions === 0) {
      throw new Error(
        `Cloudflare Browser Run acquisition rate limit reached; retry after ${currentLimits.timeUntilNextAllowedBrowserAcquisition} ms.`,
      );
    }

    const usage =
      typeof currentLimits.usedBrowserTimeSeconds === "number"
        ? ` Current browser usage: ${currentLimits.usedBrowserTimeSeconds.toFixed(1)} seconds.`
        : "";
    throw new Error(
      "Cloudflare Browser Run rejected a new browser even though acquisition and concurrency limits allow one." +
        usage +
        " Check the account's Browser Run browser-time quota.",
    );
  }
}

async function browserEndpoint(
  storage: DurableObjectStorage,
  browser: BrowserWorker,
): Promise<string> {
  const record =
    (await storedActiveSession(storage, browser)) ??
    (await adoptReusableSession(storage, browser)) ??
    (await acquireBrowserSession(storage, browser));

  return endpointURLString(browser, {
    sessionId: record.sessionId,
    persistent: true,
  });
}

/**
 * MCP Durable Object with Browser Run session affinity.
 *
 * The outer Worker routes every authenticated user's MCP transports to one
 * stable Durable Object. Browser Run affinity can therefore live in strongly
 * consistent DO storage and the Playwright connection remains single-owner.
 */
export class PlaywrightMCP extends McpAgent<
  BrowserAgentEnv,
  Record<string, never>,
  BrowserAgentProps
> {
  private serverPromise?: Promise<Server>;

  get server(): Promise<Server> {
    if (!this.serverPromise) {
      this.serverPromise = this.createServer();
    }
    return this.serverPromise;
  }

  async init(): Promise<void> {}

  private async createServer(): Promise<Server> {
    const cdpEndpoint = await browserEndpoint(
      this.ctx.storage,
      this.env.BROWSER,
    );
    const connection = await createConnection({
      capabilities: [
        "core",
        "tabs",
        "pdf",
        "history",
        "wait",
        "files",
        "testing",
      ],
      browser: { cdpEndpoint },
    });

    return connection.server as Server;
  }
}
