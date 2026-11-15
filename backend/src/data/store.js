import { config } from '../config.js';
import { WATCHED, bumpAgentCache } from '../services/agent-cache.js';

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
  /** Writes to tables the ingest cache mirrors invalidate it (see services/agent-cache.js). */
  #touch(table) {
    if (WATCHED.has(table)) bumpAgentCache();
  }
  async create(table, data) {
    this.#touch(table);
    try {
      return await this.client[table].create({ data });
    } finally {
      this.#touch(table);
    }
  }
  async update(table, id, data) {
    this.#touch(table);
    try {
      return await this.client[table].update({ where: { id }, data });
    } finally {
      this.#touch(table);
    }
  }
  async remove(table, id) {
    this.#touch(table);
    try {
      return await this.client[table].delete({ where: { id } });
    } finally {
      this.#touch(table);
    }
  }
  /** Update every row matching a Prisma `where`. Returns how many rows changed. */
  async updateMany(table, where, data) {
    this.#touch(table);
    try {
      return (await this.client[table].updateMany({ where, data })).count;
    } finally {
      this.#touch(table);
    }
  }
  /** Delete every row matching a Prisma `where` (including operators such as `{ lt }`). */
  async removeMany(table, where) {
    this.#touch(table);
    try {
      return (await this.client[table].deleteMany({ where })).count;
    } finally {
      this.#touch(table);
    }
  }
  /** Atomically update a row only if it still matches `where`. Returns true when it did. */
  async claim(table, id, where, data) {
    this.#touch(table);
    try {
      return (await this.client[table].updateMany({ where: { id, ...where }, data })).count === 1;
    } finally {
      this.#touch(table);
    }
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
