import { readFile } from 'fs/promises';
import path from 'path';
import { RecordedAction } from './session';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LLMConfig {
  endpoint: string;
  model: string;
  key: string;
}

export interface OutputSelection {
  gherkin: boolean;
  stepDefs: boolean;
  pageObjects: boolean;
}

export interface ChainResult {
  gherkin: string;
  stepDefs: string;
  pageObjects: string;
}

// ── Template loader ───────────────────────────────────────────────────────────

/**
 * Read a template file and unescape \\` sequences so code-fence backticks
 * in the template files are delivered to the LLM as plain backticks.
 */
async function loadTemplate(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf8');
  return raw.replace(/\\`/g, '`');
}

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Serialize a recorded action array into a human-readable prompt context.
 * This is the "raw input payload" fed to the first active chain step.
 */
export function buildRawContext(actions: RecordedAction[]): string {
  if (actions.length === 0) return 'No actions recorded.';

  const primaryUrl = actions[0]?.url ?? '';
  const lines: string[] = [
    `Recorded session on: ${primaryUrl}`,
    `Total steps: ${actions.length}`,
    '',
  ];

  actions.forEach((a, i) => {
    lines.push(`Step ${i + 1}: ${a.action} | value: "${a.value}" | url: ${a.url}`);
    if (a.domContext) {
      lines.push('DOM context:');
      lines.push('```html');
      lines.push(a.domContext);
      lines.push('```');
    }
    lines.push('');
  });

  return lines.join('\n');
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Interpolate a template with the context string and primary URL.
 *
 * - If the template contains ${domContextString}, perform a standard replacement.
 * - If it doesn't (e.g. the gherkin template which ends with an open HTML block),
 *   append the context and close the code fence.
 */
function buildPrompt(template: string, context: string, url: string): string {
  if (template.includes('${domContextString}')) {
    return template
      .replace(/\$\{domContextString\}/g, context)
      .replace(/\$\{pageUrl\}/g, url);
  }

  // Template ends with an open ```html block — append context and close it
  const base = template.trimEnd().replace(/`+$/, '').trimEnd();
  return `${base}\n${context}\n\`\`\``;
}

// ── LLM caller ────────────────────────────────────────────────────────────────

/**
 * Send a prompt to an OpenAI-compatible chat completions endpoint and return
 * the assistant's response text.
 */
async function callLLM(prompt: string, config: LLMConfig): Promise<string> {
  const base = config.endpoint.replace(/\/+$/, '');
  const url = base.endsWith('/completions') ? base : `${base}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  // Read body as text first so we never hit JSON.parse('') on an empty body
  // and so error responses include the raw upstream message.
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `LLM API responded ${response.status}: ${responseText.slice(0, 300)}`
    );
  }

  if (!responseText.trim()) {
    throw new Error(
      `LLM API returned an empty body (HTTP ${response.status}). ` +
      `Check that the endpoint (${url}) is correct and the model is loaded.`
    );
  }

  let data: { choices: Array<{ message: { content: string } }> };
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `LLM API returned non-JSON (HTTP ${response.status}): ${responseText.slice(0, 200)}`
    );
  }

  const content = data.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error(
      `LLM response missing choices[0].message.content. ` +
      `Raw: ${responseText.slice(0, 200)}`
    );
  }

  return content;
}

// ── Sequential chain ──────────────────────────────────────────────────────────

/**
 * Execute the Gherkin → StepDefs → PageObjects chain with hard skips.
 *
 * Hard-skip rule: if a step is unchecked it is bypassed entirely.
 * The *context* fed to each active step is the output of the previous
 * active step, or the raw action payload if no prior step ran.
 */
export type StepKey = keyof ChainResult;

export async function runChain(
  actions: RecordedAction[],
  outputs: OutputSelection,
  llm: LLMConfig,
  templatesDir: string,
  onStep: (step: StepKey, output: string) => void = () => {}
): Promise<ChainResult> {
  const primaryUrl = actions[0]?.url ?? '';
  const rawContext = buildRawContext(actions);

  const [gherkinTpl, stepdefsTpl, pageobjectTpl] = await Promise.all([
    loadTemplate(path.join(templatesDir, 'gherkin.txt')),
    loadTemplate(path.join(templatesDir, 'stepdefs.txt')),
    loadTemplate(path.join(templatesDir, 'pageobject.txt')),
  ]);

  let lastOutput: string | null = null;
  const result: ChainResult = { gherkin: '', stepDefs: '', pageObjects: '' };

  if (outputs.gherkin) {
    const prompt = buildPrompt(gherkinTpl, rawContext, primaryUrl);
    result.gherkin = await callLLM(prompt, llm);
    onStep('gherkin', result.gherkin);
    lastOutput = result.gherkin;
  }

  if (outputs.stepDefs) {
    const context = lastOutput ?? rawContext;
    const prompt = buildPrompt(stepdefsTpl, context, primaryUrl);
    result.stepDefs = await callLLM(prompt, llm);
    onStep('stepDefs', result.stepDefs);
    lastOutput = result.stepDefs;
  }

  if (outputs.pageObjects) {
    const context = lastOutput ?? rawContext;
    const prompt = buildPrompt(pageobjectTpl, context, primaryUrl);
    result.pageObjects = await callLLM(prompt, llm);
    onStep('pageObjects', result.pageObjects);
  }

  return result;
}
