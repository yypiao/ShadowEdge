import type { FastifyPluginAsync } from 'fastify';

export const registerProxyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => []);
  app.post('/', async (request) => {
    return { id: crypto.randomUUID(), ...(request.body as object) };
  });
};
