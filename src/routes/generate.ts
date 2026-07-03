import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import { runChain, LLMConfig, OutputSelection, StepKey } from '../chain';
import { RecordedAction } from '../session';

interface GenerateBody {
  actions: RecordedAction[];
  outputs: OutputSelection;
  llm: LLMConfig;
}

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

/** Maps a chain StepKey to the multipart boundary label sent to the client. */
const BOUNDARY_LABEL: Record<StepKey, string> = {
  gherkin:     'GHERKIN',
  stepDefs:    'STEPDEFS',
  pageObjects: 'PAGEOBJECTS',
};

export async function generateRoute(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/generate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['actions', 'outputs', 'llm'],
          properties: {
            actions: { type: 'array' },
            outputs: {
              type: 'object',
              properties: {
                gherkin:     { type: 'boolean' },
                stepDefs:    { type: 'boolean' },
                pageObjects: { type: 'boolean' },
              },
            },
            llm: {
              type: 'object',
              required: ['endpoint', 'model'],
              properties: {
                endpoint: { type: 'string' },
                model:    { type: 'string' },
                key:      { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: GenerateBody }>, reply: FastifyReply) => {
      const { actions, outputs, llm } = req.body;

      if (!outputs.gherkin && !outputs.stepDefs && !outputs.pageObjects) {
        return reply.code(400).send({ error: 'Select at least one output format.' });
      }

      // Take ownership of the raw socket so Fastify doesn't close it when
      // the async handler returns — we'll end it ourselves.
      reply.hijack();

      const res = reply.raw;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.writeHead(200);

      try {
        await runChain(actions, outputs, llm, TEMPLATES_DIR, (step, output) => {
          const label = BOUNDARY_LABEL[step];
          res.write(`---BOUNDARY:${label}---\n${output}\n`);
        });
      } catch (err) {
        req.log.error({ err }, 'chain execution failed');
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.write(`---BOUNDARY:ERROR---\n${message}\n`);
      }

      res.write('---BOUNDARY:END---\n');
      res.end();
    }
  );
}

