import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { recorderEmitter, RecordedAction } from '../session';

export async function eventsRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/session/events',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Take full control of the raw Node response so Fastify doesn't
      // auto-close the connection after the handler returns.
      reply.hijack();

      const res = reply.raw;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Disable Nginx / proxy buffering when behind a reverse proxy
      res.setHeader('X-Accel-Buffering', 'no');
      res.writeHead(200);
      // Confirm connection to the client immediately
      res.write(': connected\n\n');

      const listener = (action: RecordedAction): void => {
        res.write(`data: ${JSON.stringify(action)}\n\n`);
      };

      recorderEmitter.on('action', listener);

      // Heartbeat keeps the connection alive through idle proxies / firewalls
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
      }, 15_000);

      // When the Playwright browser is closed by the user, notify the client
      const stopListener = (): void => {
        res.write('event: stopped\ndata: {}\n\n');
        clearInterval(heartbeat);
        recorderEmitter.off('action', listener);
        recorderEmitter.off('sessionStopped', stopListener);
        if (!res.writableEnded) res.end();
      };

      recorderEmitter.on('sessionStopped', stopListener);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        recorderEmitter.off('action', listener);
        recorderEmitter.off('sessionStopped', stopListener);
      });

      // Hold the handler open until the client disconnects
      await new Promise<void>((resolve) => req.raw.on('close', resolve));
    }
  );
}
