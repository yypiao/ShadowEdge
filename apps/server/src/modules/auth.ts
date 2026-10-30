import type { FastifyPluginAsync } from 'fastify';

export const registerAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', async (request) => {
    const { email } = request.body as Record<string, string>;
    return { token: '', user: { email, displayName: email } };
  });

  app.post('/register', async () => {
    return { orgId: '', userId: '' };
  });
};
