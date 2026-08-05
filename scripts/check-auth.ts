/**
 * Checks authentication against a live BMC.
 * Run: npm run check:auth -- <host> [user] [password]
 */
import { connect, logout } from '../src/main/bmc/auth';
import { fail, parseTarget } from './args';

const { host, user, password } = parseTarget('check:auth');

async function main() {
  console.log(`Logging in to ${host} as ${user}...`);
  const { session, credentials } = await connect(host, user, password);
  console.log('  SessionCookie =', session.cookie);
  console.log('  kvmToken      =', credentials.kvmToken, `(${credentials.kvmToken.length} chars)`);
  console.log('  kvmPort       =', credentials.kvmPort, '| TLS:', credentials.kvmSecure);
  console.log(
    '  Virtual Media =',
    `cd:${credentials.cdPort} fd:${credentials.fdPort} hd:${credentials.hdPort}`,
  );
  console.log('  userPrivileges=', credentials.userPrivileges);
  await logout(session);
  console.log('Logout OK');
}

main().catch(fail);
