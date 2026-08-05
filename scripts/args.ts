/**
 * Shared argument parsing for the debug scripts.
 *
 * Credentials are never hard-coded: a password passed on the command line is
 * visible to every process on the machine through `ps`, so the environment
 * variables are the preferred route and positional arguments exist only for
 * quick throwaway runs.
 */

export interface Target {
  host: string;
  user: string;
  password: string;
}

/**
 * Reads the BMC address and credentials from positional arguments, falling
 * back to BMC_HOST / BMC_USER / BMC_PASSWORD. Exits with usage text when the
 * host is missing — there is no sensible default for someone else's network.
 *
 * `extraArgs` documents leading arguments a script consumes itself (an image
 * path, a key name); `offset` says how many of them to skip.
 */
export function parseTarget(script: string, extraArgs = '', offset = 0): Target {
  const [
    host = process.env.BMC_HOST,
    user = process.env.BMC_USER,
    password = process.env.BMC_PASSWORD,
  ] = process.argv.slice(2 + offset);

  if (!host) {
    console.error(
      `Usage: npm run ${script} -- ${extraArgs}<host> [user] [password]\n\n` +
        'The host is required. User and password may also be supplied through\n' +
        'the BMC_HOST, BMC_USER and BMC_PASSWORD environment variables, which\n' +
        'keeps the password out of the process list.',
    );
    process.exit(2);
  }

  return { host, user: user ?? 'ADMIN', password: password ?? '' };
}

/** Prints the error and exits — the tail every debug script ends with. */
export function fail(err: Error): never {
  console.error('ERROR:', err.message);
  process.exit(1);
}
