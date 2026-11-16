import { z } from 'zod';
import { createHash } from 'node:crypto';

/**
 * Org-defined redaction, applied by the otel worker before anything is stored. Attribute rules drop or hash
 * attributes by name; pattern rules replace well-known sensitive shapes inside string values and bodies. Only
 * built-in patterns exist (no user regex), so a rule can never make ingest slow.
 */
const luhn = (digits) => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

export const PRESETS = {
  email: { regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g },
  credit_card: {
    regex: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    accept: (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    },
  },
  ipv4: { regex: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g },
  jwt: { regex: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  bearer: { regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
};

const id = z.string().max(40).optional();
export const redactionRuleSchema = z.discriminatedUnion('type', [
  z.object({
    id,
    type: z.literal('attribute'),
    key: z.string().trim().min(1).max(200),
    action: z.enum(['drop', 'hash']),
  }),
  z.object({
    id,
    type: z.literal('pattern'),
    preset: z.enum(Object.keys(PRESETS)),
    action: z.enum(['mask', 'hash']),
  }),
]);
export const redactionSchema = z.object({ rules: z.array(redactionRuleSchema).max(50) });

export const hashValue = (orgId, value) =>
  `sha256:${createHash('sha256').update(`${orgId}:${value}`).digest('hex').slice(0, 16)}`;

/** Compile rules once per batch: returns { attrs(map), text(string), active }. */
export function compileRedaction(orgId, rules = []) {
  const attrRules = rules.filter((r) => r.type === 'attribute').map((r) => {
    const key = r.key.toLowerCase();
    return { prefix: key.endsWith('*') ? key.slice(0, -1) : null, exact: key.endsWith('*') ? null : key, action: r.action };
  });
  const patternRules = rules.filter((r) => r.type === 'pattern');
  const replacer = (rule) => (match) => {
    const preset = PRESETS[rule.preset];
    if (preset.accept && !preset.accept(match)) return match;
    return rule.action === 'hash' ? hashValue(orgId, match) : `[REDACTED:${rule.preset}]`;
  };
  const patterns = patternRules.map((rule) => ({ regex: PRESETS[rule.preset].regex, replace: replacer(rule) }));

  const text = (value) => {
    if (typeof value !== 'string' || !value || !patterns.length) return value;
    let out = value;
    for (const p of patterns) out = out.replace(p.regex, p.replace);
    return out;
  };
  const attrs = (map) => {
    if (!map) return map;
    const out = {};
    for (const [key, value] of Object.entries(map)) {
      const lower = key.toLowerCase();
      const rule = attrRules.find((r) => (r.exact !== null ? r.exact === lower : lower.startsWith(r.prefix)));
      if (rule?.action === 'drop') continue;
      out[key] = rule ? hashValue(orgId, value) : text(value);
    }
    return out;
  };
  return { attrs, text, active: attrRules.length + patterns.length > 0 };
}

const SPAN_MAPS = ['ResourceAttributes', 'SpanAttributes'];
const LOG_MAPS = ['ResourceAttributes', 'LogAttributes'];

/** Redact flat rows in place (traces or logs). */
export function redactRows(signal, rows, redaction) {
  if (!redaction.active) return rows;
  for (const row of rows) {
    if (signal === 'traces') {
      for (const k of SPAN_MAPS) row[k] = redaction.attrs(row[k]);
      row['Events.Attributes'] = row['Events.Attributes'].map(redaction.attrs);
      row['Links.Attributes'] = row['Links.Attributes'].map(redaction.attrs);
      row.SpanName = redaction.text(row.SpanName);
      row.StatusMessage = redaction.text(row.StatusMessage);
      row['Events.Name'] = row['Events.Name'].map(redaction.text);
    } else {
      for (const k of LOG_MAPS) row[k] = redaction.attrs(row[k]);
      row.Body = redaction.text(row.Body);
    }
  }
  return rows;
}
