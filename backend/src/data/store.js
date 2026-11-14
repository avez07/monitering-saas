import { config } from '../config.js';

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
  create(table, data) {
    return this.client[table].create({ data });
  }
  update(table, id, data) {
    return this.client[table].update({ where: { id }, data });
  }
  remove(table, id) {
    return this.client[table].delete({ where: { id } });
  }
  /** Delete every row matching a Prisma `where` (including operators such as `{ lt }`). */
  async removeMany(table, where) {
    return (await this.client[table].deleteMany({ where })).count;
  }
  /** Atomically update a row only if it still matches `where`. Returns true when it did. */
  async claim(table, id, where, data) {
    return (await this.client[table].updateMany({ where: { id, ...where }, data })).count === 1;
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
  await store.client.$connect();
  return store;
}
