import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { startSession, stopSession, hasActiveSession } from '../session';

interface StartBody {
  url: string;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/session/start
  app.post(
    '/api/session/start',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: StartBody }>, reply: FastifyReply) => {
      if (hasActiveSession()) {
        return reply
          .code(409)
          .send({ error: 'A session is already active. Stop it first.' });
      }

      const { url } = req.body;

      try {
        await startSession(url, req.log);
        return reply.code(200).send({ status: 'started', url });
      } catch (err) {
        req.log.error({ err }, 'failed to start session');
        return reply.code(500).send({ error: 'Failed to start session.' });
      }
    }
  );

  // POST /api/session/stop
  app.post(
    '/api/session/stop',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      if (!hasActiveSession()) {
        return reply.code(409).send({ error: 'No active session to stop.' });
      }

      try {
        await stopSession(_req.log);
        return reply.code(200).send({ status: 'stopped' });
      } catch (err) {
        _req.log.error({ err }, 'failed to stop session');
        return reply.code(500).send({ error: 'Failed to stop session.' });
      }
    }
  );
}
