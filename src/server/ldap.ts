// =====================================================================
// The directory: LDAP / Active Directory.
//
// Two uses. Signing in: an account whose auth_source is 'ldap' has no
// password here; the directory checks it. And the people sync: everybody
// in the directory becomes an employee record, with department, title,
// work address and line manager, through the same import_employees() the
// HR file uses — so a directory and a spreadsheet cannot disagree about
// what a person is.
//
// Configured by environment, for the one tenant named by LDAP_TENANT: a
// deployment serves one organisation's directory. Nothing here is
// reachable from another tenant, and an evaluation without a directory
// simply does not offer it.
//
//   LDAP_URL                 ldaps://dc.example.com:636 (ldap:// for a lab)
//   LDAP_BIND_DN             the service account that searches
//   LDAP_BIND_PASSWORD
//   LDAP_BASE_DN             where people are, e.g. ou=people,dc=example,dc=com
//   LDAP_TENANT              the tenant slug the directory belongs to
//   LDAP_USER_FILTER         default (&(objectClass=inetOrgPerson)(uid={username}))
//                            Active Directory: (&(objectClass=user)(sAMAccountName={username}))
//   LDAP_PEOPLE_FILTER       default (objectClass=inetOrgPerson)
//   LDAP_ATTR_EMPLOYEE_ID    default employeeNumber
//   LDAP_ATTR_NAME           default cn            (AD: displayName)
//   LDAP_ATTR_EMAIL          default mail
//   LDAP_ATTR_DEPARTMENT     default departmentNumber (AD: department)
//   LDAP_ATTR_TITLE          default title
//   LDAP_ATTR_MANAGER        default manager       (a DN, as in both)
//   LDAP_TLS_INSECURE        'true' to accept a self-signed certificate
// =====================================================================

import { Client } from 'ldapts';

export type DirectoryConfig = {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  tenant: string;
  userFilter: string;
  peopleFilter: string;
  attrs: { employeeId: string; name: string; email: string; department: string; title: string; manager: string };
  insecure: boolean;
};

export function directoryConfig(env: NodeJS.ProcessEnv = process.env): DirectoryConfig | null {
  if (!env.LDAP_URL || !env.LDAP_BASE_DN || !env.LDAP_TENANT) return null;
  return {
    url: env.LDAP_URL,
    bindDn: env.LDAP_BIND_DN ?? '',
    bindPassword: env.LDAP_BIND_PASSWORD ?? '',
    baseDn: env.LDAP_BASE_DN,
    tenant: env.LDAP_TENANT,
    userFilter: env.LDAP_USER_FILTER || '(&(objectClass=inetOrgPerson)(uid={username}))',
    peopleFilter: env.LDAP_PEOPLE_FILTER || '(objectClass=inetOrgPerson)',
    attrs: {
      employeeId: env.LDAP_ATTR_EMPLOYEE_ID || 'employeeNumber',
      name: env.LDAP_ATTR_NAME || 'cn',
      email: env.LDAP_ATTR_EMAIL || 'mail',
      department: env.LDAP_ATTR_DEPARTMENT || 'departmentNumber',
      title: env.LDAP_ATTR_TITLE || 'title',
      manager: env.LDAP_ATTR_MANAGER || 'manager',
    },
    insecure: env.LDAP_TLS_INSECURE === 'true',
  };
}

/** RFC 4515: a value placed in a filter cannot change the filter. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function client(cfg: DirectoryConfig): Client {
  return new Client({
    url: cfg.url,
    timeout: 8_000,
    connectTimeout: 5_000,
    tlsOptions: cfg.url.startsWith('ldaps:') ? { rejectUnauthorized: !cfg.insecure } : undefined,
  });
}

function first(v: unknown): string {
  if (Array.isArray(v)) return v.length ? first(v[0]) : '';
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v == null ? '' : String(v);
}

/**
 * Does the directory accept this password for this username?
 *
 * Searches as the service account for the person's DN, then binds as
 * them. An empty password is refused here: many directories treat a bind
 * with no password as an anonymous bind and say yes to it.
 */
export async function directoryAuthenticate(username: string, password: string, cfg = directoryConfig()): Promise<boolean> {
  if (!cfg || !username || !password) return false;
  const svc = client(cfg);
  let dn: string | null = null;
  try {
    if (cfg.bindDn) await svc.bind(cfg.bindDn, cfg.bindPassword);
    const filter = cfg.userFilter.replaceAll('{username}', escapeFilterValue(username));
    const { searchEntries } = await svc.search(cfg.baseDn, { scope: 'sub', filter, attributes: ['dn'], sizeLimit: 2 });
    if (searchEntries.length !== 1) return false;
    dn = searchEntries[0].dn;
  } catch (err) {
    console.error('[ldap] lookup failed', err instanceof Error ? err.message : err);
    return false;
  } finally {
    await svc.unbind().catch(() => {});
  }

  const user = client(cfg);
  try {
    await user.bind(dn, password);
    return true;
  } catch {
    return false;
  } finally {
    await user.unbind().catch(() => {});
  }
}

export type DirectoryPerson = {
  employee_id: string;
  name: string;
  email: string | null;
  department: string | null;
  designation: string | null;
  line_manager_id: string | null;
  username: string | null;
};

/**
 * Everybody in the directory, shaped as rows for import_employees().
 * A manager is a DN in the directory; it is resolved to that person's
 * employee id here, so the import sees one key throughout.
 */
export async function directoryPeople(cfg = directoryConfig()): Promise<DirectoryPerson[]> {
  if (!cfg) throw new Error('No directory is configured.');
  const svc = client(cfg);
  try {
    if (cfg.bindDn) await svc.bind(cfg.bindDn, cfg.bindPassword);
    const a = cfg.attrs;
    const uidAttr = /\(\s*(\w+)\s*=\s*\{username\}\s*\)/.exec(cfg.userFilter)?.[1] ?? 'uid';
    const { searchEntries } = await svc.search(cfg.baseDn, {
      scope: 'sub',
      filter: cfg.peopleFilter,
      attributes: [a.employeeId, a.name, a.email, a.department, a.title, a.manager, uidAttr],
      paged: { pageSize: 500 },
    });

    const idByDn = new Map<string, string>();
    for (const e of searchEntries) {
      const id = first(e[a.employeeId]);
      if (id) idByDn.set(e.dn.toLowerCase(), id);
    }
    return searchEntries
      .filter((e) => first(e[a.employeeId]))
      .map((e) => ({
        employee_id: first(e[a.employeeId]),
        name: first(e[a.name]) || first(e[a.employeeId]),
        email: first(e[a.email]) || null,
        department: first(e[a.department]) || null,
        designation: first(e[a.title]) || null,
        line_manager_id: idByDn.get(first(e[a.manager]).toLowerCase()) ?? null,
        username: first(e[uidAttr]) || null,
      }));
  } finally {
    await svc.unbind().catch(() => {});
  }
}
