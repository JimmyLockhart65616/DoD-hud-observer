/**
 * Prints a `caster_auth.users` password_hash entry for config.yaml.
 *
 * Usage: npx ts-node --script-mode scripts/hash-caster-password.ts <password>
 *
 * Paste the output as the `password_hash` for a user in caster_auth.users:
 *   caster_auth:
 *     users:
 *       - username: coreymarko
 *         password_hash: "<paste here>"
 *
 * Never put a plaintext password in config.yaml -- this is the only step
 * that should ever see one.
 */
import { hashPassword } from '../backend/src/handler/casterAuth';

const password = process.argv[2];
if (!password) {
    console.error('Usage: hash-caster-password.ts <password>');
    process.exit(1);
}
console.log(hashPassword(password));
