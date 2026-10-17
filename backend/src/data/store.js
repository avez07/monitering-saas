import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { config, root } from '../config.js';

// One repository contract for the local JSON store and PostgreSQL/Prisma.
export class MemoryStore {
  constructor(initial = {}, file = null) {
    this.tables = structuredClone(initial);
    this.file = file;
    this.queue = Promise.resolve();
  }
  async list(table, where = {}) {
    return structuredClone(
      (this.tables[table] || []).filter((row) =>
        Object.entries(where).every(([k, v]) => row[k] === v),
      ),
    );
  }
  async find(table, where) {
    return (await this.list(table, where))[0] || null;
  }
  async create(table, data) {
    const unique = {
      user: [['email']],
      organization: [['slug']],
      organizationMember: [['orgId', 'userId']],
      project: [['orgId', 'slug']],
      environment: [['orgId', 'projectId', 'name']],
      agentCredential: [['tokenHash']],
      agentEnrollmentToken: [['tokenHash']],
      subscription: [['orgId']],
      usageAggregate: [['orgId', 'kind', 'period']],
      payment: [['providerId']],
      invoice: [['number']],
    };
    const conflicts = (this.tables[table] || []).some(
      (r) =>
        (data.id && r.id === data.id) ||
        (unique[table] || []).some((keys) => keys.every((k) => r[k] === data[k])),
    );
    if (conflicts) {
      const error = new Error('This record already exists.');
      error.code = 'P2002';
      throw error;
    }
    const row = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    };
    (this.tables[table] ||= []).push(row);
    await this.persist();
    return structuredClone(row);
  }
  async update(table, id, data) {
    const row = (this.tables[table] || []).find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    await this.persist();
    return structuredClone(row);
  }
  async remove(table, id) {
    this.tables[table] = (this.tables[table] || []).filter((r) => r.id !== id);
    await this.persist();
  }
  async claim(table, id, where, data) {
    const row = (this.tables[table] || []).find(
      (r) => r.id === id && Object.entries(where).every(([k, v]) => r[k] === v),
    );
    if (!row) return false;
    Object.assign(row, data, { updatedAt: new Date().toISOString() });
    await this.persist();
    return true;
  }
  async transaction(fn) {
    const snapshot = structuredClone(this.tables);
    try {
      return await fn(this);
    } catch (error) {
      this.tables = snapshot;
      await this.persist();
      throw error;
    }
  }
  async persist() {
    if (!this.file) return;
    const content = JSON.stringify(this.tables, null, 2);
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, content);
      await rename(`${this.file}.tmp`, this.file);
    });
    await this.queue;
  }
  async close() {
    await this.queue;
  }
}
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
export async function createStore() {
  if (!config.DEMO_MODE) {
    const { PrismaClient } = await import('@prisma/client');
    const store = new PrismaStore(new PrismaClient());
    await store.client.$connect();
    return store;
  }
  const file = `${root}/backend/data/demo.json`;
  let initial = {};
  try {
    initial = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return new MemoryStore(initial, file);
}
