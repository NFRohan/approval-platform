// =====================================================================
// The directory connector, against a real OpenLDAP server.
//
//   npm run test:ldap
//
// Starts osixia/openldap in Docker on a free local port, writes a small
// organisation into it, and checks the two things the connector does:
// signing somebody in with their directory password, and reading
// everybody out as HR rows with their managers resolved. Then removes
// the container. Needs Docker; nothing else.
//
// Set LDAP_TEST_KEEP=1 to leave the container running afterwards.
// =====================================================================

import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';

const NL = String.fromCharCode(10);
const NAME = 'approval-platform-ldap-test';
const BASE = 'dc=example,dc=com';
const ADMIN = `cn=admin,${BASE}`;
const ADMIN_PW = 'admin-password-for-tests';

let passed = 0;
const failures = [];
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { passed += 1; console.log(`  pass: ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try { docker('rm', '-f', NAME); } catch { /* not there */ }
docker('run', '-d', '--name', NAME, '-p', '127.0.0.1::389',
  '-e', 'LDAP_ORGANISATION=Example', '-e', 'LDAP_DOMAIN=example.com',
  '-e', `LDAP_ADMIN_PASSWORD=${ADMIN_PW}`, '-e', 'LDAP_TLS=false',
  // A read-only account for the connector to search with, as a real
  // directory would grant one: the default ACL hides entries from
  // everybody but the admin and the entry itself.
  '-e', 'LDAP_READONLY_USER=true', '-e', 'LDAP_READONLY_USER_USERNAME=ams',
  '-e', 'LDAP_READONLY_USER_PASSWORD=service-password-1',
  'osixia/openldap:1.5.0');
const port = docker('port', NAME, '389/tcp').split(NL)[0].split(':').pop();
const url = `ldap://127.0.0.1:${port}`;

const vite = await createServer({
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true },
});
const { Client } = await import('ldapts');

try {
  // The server takes a few seconds to come up.
  const admin = new Client({ url, timeout: 5000, connectTimeout: 3000 });
  for (let i = 0; ; i++) {
    try { await admin.bind(ADMIN, ADMIN_PW); break; } catch (err) {
      if (i > 60) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ------------------------------------------------------------- the org
  await admin.add(`ou=people,${BASE}`, { objectClass: ['organizationalUnit'], ou: 'people' });
  const person = (uid, cn, no, dept, title, manager, pw) => admin.add(`uid=${uid},ou=people,${BASE}`, {
    objectClass: ['inetOrgPerson'], uid, cn, sn: cn.split(' ').pop(), employeeNumber: no,
    departmentNumber: dept, title, mail: `${uid}@example.com`, userPassword: pw,
    ...(manager ? { manager: `uid=${manager},ou=people,${BASE}` } : {}),
  });
  await person('rahim.uddin', 'Rahim Uddin', 'BK-1001', 'Finance', 'Head of Finance', null, 'Rahim-Directory-Pw1!');
  await person('karim.ahmed', 'Karim Ahmed', 'BK-1002', 'Finance', 'Finance Officer', 'rahim.uddin', 'Karim-Directory-Pw1!');
  await person('nusrat.jahan', 'Nusrat Jahan', 'BK-1003', 'HR', 'HR Business Partner', 'rahim.uddin', 'Nusrat-Directory-Pw1!');
  // In the directory but with no employee number: not an employee record.
  await admin.add(`uid=printer,ou=people,${BASE}`, { objectClass: ['inetOrgPerson'], uid: 'printer', cn: 'Printer', sn: 'Printer' });
  await admin.unbind();

  const { directoryAuthenticate, directoryPeople, directoryConfig, escapeFilterValue } =
    await vite.ssrLoadModule('/src/server/ldap.ts');
  const cfg = directoryConfig({
    LDAP_URL: url,
    LDAP_BIND_DN: `cn=ams,${BASE}`,
    LDAP_BIND_PASSWORD: 'service-password-1',
    LDAP_BASE_DN: `ou=people,${BASE}`,
    LDAP_TENANT: 'test',
  });

  console.log(NL + 'ldap' + NL);

  // ----------------------------------------------------------- signing in
  check('the directory accepts the right password', await directoryAuthenticate('karim.ahmed', 'Karim-Directory-Pw1!', cfg), true);
  check('...and refuses a wrong one', await directoryAuthenticate('karim.ahmed', 'not-it', cfg), false);
  check('an empty password is refused, not taken as an anonymous bind', await directoryAuthenticate('karim.ahmed', '', cfg), false);
  check('somebody not in the directory is refused', await directoryAuthenticate('nobody', 'Karim-Directory-Pw1!', cfg), false);
  check('a wildcard in the username matches nobody', await directoryAuthenticate('k*', 'Karim-Directory-Pw1!', cfg), false);
  check('a filter in the username cannot widen the search',
    await directoryAuthenticate('*)(uid=*', 'Karim-Directory-Pw1!', cfg), false);
  check('filter values are escaped per RFC 4515', escapeFilterValue('a*b(c)\\d'), 'a\\2ab\\28c\\29\\5cd');
  check('a wrong service password fails closed',
    await directoryAuthenticate('karim.ahmed', 'Karim-Directory-Pw1!', { ...cfg, bindPassword: 'wrong' }), false);
  check('an unreachable directory fails closed',
    await directoryAuthenticate('karim.ahmed', 'Karim-Directory-Pw1!', { ...cfg, url: 'ldap://127.0.0.1:1' }), false);

  // --------------------------------------------------------- reading people
  const people = (await directoryPeople(cfg)).sort((a, b) => a.employee_id.localeCompare(b.employee_id));
  check('everybody with an employee number is read, nobody else', people.map((p) => p.employee_id), ['BK-1001', 'BK-1002', 'BK-1003']);
  check('...with name, department, title and work address',
    [people[1].name, people[1].department, people[1].designation, people[1].email],
    ['Karim Ahmed', 'Finance', 'Finance Officer', 'karim.ahmed@example.com']);
  check('a manager, a DN in the directory, becomes their employee id',
    people.map((p) => p.line_manager_id), [null, 'BK-1001', 'BK-1001']);
  check('...and the username comes along for registering accounts', people[2].username, 'nusrat.jahan');
} finally {
  await vite.close();
  if (!process.env.LDAP_TEST_KEEP) {
    try { docker('rm', '-f', NAME); } catch { /* gone */ }
  } else {
    console.log(`${NL}left running: ${url} (container ${NAME})`);
  }
}

if (failures.length) {
  console.log(`${NL}${failures.length} LDAP CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`${NL}ALL LDAP CHECKS PASSED (${passed})`);
