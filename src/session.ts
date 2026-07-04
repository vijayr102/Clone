import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { FastifyBaseLogger } from 'fastify';
import { EventEmitter } from 'events';
import { recorderScript } from './injector';

export interface RecordedAction {
  id: string;
  action: string;
  value: string;
  url: string;
  domContext: string;
}

interface ActiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

/**
 * Emits 'action' events with a RecordedAction payload.
 * Consumed by the SSE route in Phase 5.
 */
export const recorderEmitter = new EventEmitter();

let activeSession: ActiveSession | null = null;

function handleAction(payload: RecordedAction, logger: FastifyBaseLogger): void {
  logger.info({ payload }, 'action recorded');
  recorderEmitter.emit('action', payload);
}

/**
 * Expose the onActionRecorded RPC tunnel on a page so the injected
 * sniffing script can route captured interactions back to Fastify.
 *
 * Must be called BEFORE the page navigates so the binding is available
 * when the init script runs.
 */
async function registerPageBindings(
  page: Page,
  logger: FastifyBaseLogger
): Promise<void> {
  await page.exposeFunction('onActionRecorded', (payload: RecordedAction) => {
    handleAction(payload, logger);
  });
  logger.info('page bindings registered');
}

/**
 * Start a new isolated headful Chromium session and navigate to the target URL.
 * Throws if a session is already active.
 */
export async function startSession(
  url: string,
  logger: FastifyBaseLogger
): Promise<void> {
  if (activeSession) {
    throw new Error('A recording session is already active. Stop it first.');
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // Inject the sniffing script into EVERY page in this context automatically,
  // including tabs opened via target="_blank". Runs before any page scripts.
  await context.addInitScript(recorderScript);

  const page = await context.newPage();
  await registerPageBindings(page, logger);

  // Intercept new tabs / popups — register bindings IMMEDIATELY (before navigation)
  // so window.onActionRecorded is available when the init script fires.
  context.on('page', async (newPage: Page) => {
    logger.info('new tab/popup detected');
    try {
      await registerPageBindings(newPage, logger);
    } catch (err) {
      logger.warn({ err }, 'failed to register bindings on new tab');
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  activeSession = { browser, context, page };

  // Auto-stop when the user closes the Playwright browser window manually
  browser.on('disconnected', () => {
    if (!activeSession) return; // already stopped via API
    activeSession = null;
    logger.info('browser closed by user — session auto-stopped');
    recorderEmitter.emit('sessionStopped');
  });

  logger.info({ url }, 'session started');
}

/**
 * Gracefully stop the active session and release all resources.
 * Throws if no session is running.
 */
export async function stopSession(logger: FastifyBaseLogger): Promise<void> {
  if (!activeSession) {
    throw new Error('No active session to stop.');
  }

  const { browser } = activeSession;
  activeSession = null;

  await browser.close();
  logger.info('session stopped');
}

/** Returns true when a session is currently running. */
export function hasActiveSession(): boolean {
  return activeSession !== null;
}
