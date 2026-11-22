import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { liveServers } from './servers.js';
import { promSeen } from './prom-remote.js';

/** Preset dashboards shipped with the API (backend/src/dashboards/*.json, see scripts/import-grafana.mjs). */
const DIR = fileURLToPath(new URL('../dashboards/', import.meta.url));
let presets = null;
function load() {
  if (presets) return presets;
  presets = new Map();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    const doc = JSON.parse(readFileSync(`${DIR}${file}`, 'utf8'));
    if (doc?.id) presets.set(doc.id, doc);
  }
  return presets;
}
export const listPresets = () => [...load().values()].map(({ id, title, description }) => ({ id, title, description }));
export const findPreset = (id) => load().get(id) ?? null;

/** A host counts as having advanced data when it wrote remote_write within the retention (30 days). */
const HAS_DATA_MS = 30 * 86400000;

/** The organization's servers, with whether each one has sent Prometheus data (`hasData`). */
export async function dashboardTargets(store, orgId, now = Date.now()) {
  const [servers, seen] = await Promise.all([liveServers(store, orgId), promSeen(orgId)]);
  return servers
    .map(({ agent, resource }) => {
      const last = seen.get(agent.id);
      return {
        agentId: agent.id,
        name: resource.name ?? agent.name ?? '',
        os: agent.os || agent.platform || '',
        platform: agent.platform || '',
        agentVersion: agent.version || '',
        hasData: Boolean(last && now - last < HAS_DATA_MS),
        lastDataAt: last ? new Date(last).toISOString() : null,
      };
    })
    .sort((a, b) => Number(b.hasData) - Number(a.hasData) || String(a.name).localeCompare(String(b.name)));
}
