import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { CURRENT_CATALOG_VERSION, generateFingerprint } from '@shadowedge/fingerprint';

const createSchema = z.object({
  name: z.string().min(1).max(64),
  platformTag: z.string().optional(),
  proxyId: z.string().optional(),
  fingerprintSeed: z.string().optional(),
});

export const registerProfileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => []);

  app.post('/', async (request) => {
    const input = createSchema.parse(request.body);
    return {
      id: crypto.randomUUID(),
      ...input,
      fingerprint: generateFingerprint({
        seed: input.fingerprintSeed ?? crypto.randomUUID(),
        catalogVersion: CURRENT_CATALOG_VERSION,
      }),
      status: 'idle',
    };
  });

  app.get<{ Params: { id: string } }>('/:id', async (request) => {
    return { id: request.params.id, name: 'demo', status: 'idle' };
  });

  app.post<{ Params: { id: string } }>('/:id/launch', async () => {
    return { profileId: '', sessionId: '', startedAt: new Date().toISOString() };
  });
};
