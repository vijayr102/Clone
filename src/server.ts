import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import dotenv from 'dotenv';
import { sessionRoutes } from './routes/session';
import { eventsRoute } from './routes/events';
import { generateRoute } from './routes/generate';

dotenv.config();

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: true });

app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

app.register(sessionRoutes);
app.register(eventsRoute);
app.register(generateRoute);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
