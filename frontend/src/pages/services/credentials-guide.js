// Database credentials for deep metrics. Contract: docs/api/advanced-telemetry.md section 6.
// YuktiOps stores only a reference name; the agent reads the user and password on the host.

export const CREDENTIAL_KINDS = ['redis', 'mysql', 'postgres', 'mssql'];
export const CREDENTIALS_REF = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An error message for a reference, or '' when it is valid (empty is valid: credentials are optional). */
export function credentialsRefError(ref) {
  const v = String(ref || '').trim();
  if (!v) return '';
  return CREDENTIALS_REF.test(v)
    ? ''
    : 'Use up to 40 lowercase letters, digits and dashes, starting with a letter or digit.';
}

/** YUKTIOPS_CRED_<REF>: the reference upper-cased with - replaced by _. */
export const envPrefix = (ref) => `YUKTIOPS_CRED_${String(ref).toUpperCase().replace(/-/g, '_')}`;

const GRANT = {
  redis: {
    label: 'Run in redis-cli',
    code: 'ACL SETUSER yuktiops on >PASS +ping +info +client|list',
    note: 'Redis 6 or newer. On older Redis there are no users: leave USER out and set PASSWORD to the requirepass value.',
  },
  mysql: {
    label: 'Run in the mysql client as an admin',
    code: "CREATE USER 'yuktiops'@'%' IDENTIFIED BY 'PASS';\nGRANT PROCESS, REPLICATION CLIENT ON *.* TO 'yuktiops'@'%';",
  },
  postgres: {
    label: 'Run in psql as a superuser',
    code: "CREATE ROLE yuktiops LOGIN PASSWORD 'PASS';\nGRANT pg_monitor TO yuktiops;",
  },
  mssql: {
    label: 'Run in sqlcmd or SSMS as an admin',
    code: "CREATE LOGIN yuktiops WITH PASSWORD='PASS';\nGRANT VIEW SERVER STATE TO yuktiops;",
  },
};

/** Copy-paste steps for one database kind and reference. */
export function credentialSteps(kind, ref) {
  const name = String(ref || '').trim() || `${kind}-main`;
  const prefix = envPrefix(name);
  const grant = GRANT[kind];
  return {
    ref: name,
    grant,
    file: {
      linux: `sudo install -d -m 0700 -o yuktiops -g yuktiops /etc/yuktiops/credentials.d
sudo install -m 0600 -o yuktiops -g yuktiops /dev/null /etc/yuktiops/credentials.d/${name}.env
sudo tee /etc/yuktiops/credentials.d/${name}.env >/dev/null <<'EOF'
USER=yuktiops
PASSWORD=PASS
EOF`,
      windows: `%PROGRAMDATA%\\yuktiops\\credentials.d\\${name}.env`,
    },
    env: `${prefix}_USER=yuktiops\n${prefix}_PASSWORD=PASS`,
  };
}
