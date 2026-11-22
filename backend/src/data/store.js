import { config } from '../config.js';
import { WATCHED, invalidateAgents } from '../services/agent-cache.js';

// One small repository contract over Prisma, so services stay readable and tests can use a real database.
export class PrismaStore {
  constructor(client) {
    this.client = client;
  }
  list(table, where = {}) {
    return this.client[table].findMany({ where });
  }
  find(table, where) {
    return this.client[table].findFirst({ where });
  }
  /**
   * Writes to tables the ingest cache mirrors invalidate it on every API instance (see
   * services/agent-cache.js). Credential revocations also mark each credential revoked in Redis.
   * It runs before and after the write so a cache refill that races the write cannot survive.
   */
  async #touch(table, { target = '*', revoked = [] } = {}) {
    if (!WATCHED.has(table)) return;
    try {
      await invalidateAgents(target, { revokedCredentialIds: revoked });
    } catch (error) {
      // Redis trouble must not turn a successful database write into a 500; cached entries expire on their own
      // (TTL). A credential revocation is the exception: it must reach every instance, so it still fails loudly.
      if (revoked.length) throw error;
      console.error('store: agent cache invalidation failed:', error.message);
    }
  }
  /** Ids of credentials a write is about to revoke (so they can be blocked instantly everywhere). */
  async #revoking(table, where, data) {
    if (table !== 'agentCredential' || !data?.revokedAt) return [];
    return (await this.client.agentCredential.findMany({ where, select: { id: true } })).map(
      (row) => row.id,
    );
  }
  async #write(table, opts, run) {
    await this.#touch(table, opts);
    try {
      return await run();
    } finally {
      await this.#touch(table, opts);
    }
  }
  create(table, data) {
    return this.#write(table, {}, () => this.client[table].create({ data }));
  }
  async update(table, id, data) {
    const revoked = await this.#revoking(table, { id }, data);
    const target = table === 'agent' ? id : '*';
    return this.#write(table, { target, revoked }, () =>
      this.client[table].update({ where: { id }, data }),
    );
  }
  async remove(table, id) {
    const revoked = table === 'agentCredential' ? [id] : [];
    return this.#write(table, { revoked }, () => this.client[table].delete({ where: { id } }));
  }
  /** Update every row matching a Prisma `where`. Returns how many rows changed. */
  async updateMany(table, where, data) {
    const revoked = await this.#revoking(table, where, data);
    return this.#write(
      table,
      { revoked },
      async () => (await this.client[table].updateMany({ where, data })).count,
    );
  }
  /** Delete every row matching a Prisma `where` (including operators such as `{ lt }`). */
  removeMany(table, where) {
    return this.#write(table, {}, async () => (await this.client[table].deleteMany({ where })).count);
  }
  /** Atomically update a row only if it still matches `where`. Returns true when it did. */
  async claim(table, id, where, data) {
    const revoked = await this.#revoking(table, { id, ...where }, data);
    return this.#write(
      table,
      { revoked },
      async () => (await this.client[table].updateMany({ where: { id, ...where }, data })).count === 1,
    );
  }
  transaction(fn) {
    return this.client.$transaction((tx) => fn(new PrismaStore(tx)), {
      isolationLevel: 'Serializable',
      timeout: 15000,
    });
  }
  close() {
    return this.client.$disconnect();
  }
}
export async function createStore(url = config.DATABASE_URL) {
  const { PrismaClient } = await import('@prisma/client');
  const store = new PrismaStore(new PrismaClient({ datasources: { db: { url } } }));
  // Warm up: open the first connection and run a trivial query so the first real request is not slow.
  await store.client.$connect();
  await store.client.$queryRaw`SELECT 1`;
  return store;
}
