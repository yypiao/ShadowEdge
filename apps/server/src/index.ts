import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createConsoleLogger, isShadowEdgeError } from '@shadowedge/core';
import { registerProfileRoutes } from './modules/profiles.js';
import { registerProxyRoutes } from './modules/proxies.js';
import { registerAuthRoutes } from './modules/auth.js';

const logger = createConsoleLogger({ component: 'server' });

async function main() {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((error, _request, reply) => {
    if (isShadowEdgeError(error)) {
      const status = error.code === 'E_PERMISSION_DENIED' ? 403 : error.code === 'E_AUTH_REQUIRED' ? 401 : 400;
      return reply.status(status).send(error.toJSON());
    }
    logger.error('未处理异常', { error: String(error) });
    return reply.status(500).send({ code: 'E_INTERNAL', message: '服务器内部错误' });
  });

  app.get('/healthz', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  await app.register(registerAuthRoutes, { prefix: '/v1/auth' });
  await app.register(registerProfileRoutes, { prefix: '/v1/profiles' });
  await app.register(registerProxyRoutes, { prefix: '/v1/proxies' });

  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info('ShadowEdge server 已启动', { port });
}

main().catch((error) => {
  logger.error('启动失败', { error: String(error) });
  process.exit(1);
});
