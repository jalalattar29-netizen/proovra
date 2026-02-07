import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      sub: string;
      provider: string;
      email?: string | null;
    };
  }
}
