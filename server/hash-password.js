'use strict';
// Creates the login settings for the editor.
//
//   node hash-password.js <username> > latex-auth.env
//
// Asks for the password twice (nothing is shown while typing) and prints:
//   AUTH_USER=…        the username
//   AUTH_HASH=scrypt:… the password, hashed (the password itself is never stored)
//   SESSION_SECRET=…   a random key that signs the login cookie
// Changing SESSION_SECRET logs out every open session.

const crypto = require('node:crypto');
const readline = require('node:readline');

const user = process.argv[2];
if (!user || !/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
  process.stderr.write('usage: node hash-password.js <username>   (letters, digits, . _ -)\n');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
    process.stderr.write(prompt);
    rl._writeToOutput = () => {}; // do not echo what is typed
    rl.question('', (answer) => {
      rl.close();
      if (process.stdin.isTTY) process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readPasswords() {
  if (process.stdin.isTTY) return [await ask('Password: '), await ask('Password again: ')];
  // piped: two lines on stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return [lines[0] || '', lines[1] || ''];
}

(async () => {
  const [pw, again] = await readPasswords();
  if (pw !== again) { process.stderr.write('The two passwords differ. Nothing written.\n'); process.exit(1); }
  if (pw.length < 10) { process.stderr.write('Use at least 10 characters. Nothing written.\n'); process.exit(1); }
  const N = 32768; const r = 8; const p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  process.stdout.write(`AUTH_USER=${user}\n`);
  process.stdout.write(`AUTH_HASH=scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${hash.toString('base64url')}\n`);
  process.stdout.write(`SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}\n`);
  process.stderr.write('Done.\n');
})();
