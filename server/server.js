'use strict';
// latex.thudal.com — tiny backend for the LaTeX editor.
// Zero npm dependencies: only Node's standard library.
// Listens on 127.0.0.1 only; Caddy handles HTTPS and the password.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONFIG = {
  host: '127.0.0.1',
  port: Number(process.env.PORT || 8090),
  docsDir: path.resolve(process.env.DOCS_DIR || '/var/lib/latex/docs'),
  publicDir: path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public')),
  compileTimeoutMs: Number(process.env.COMPILE_TIMEOUT_MS || 60000),
  sandbox: process.env.SANDBOX !== 'off', // 'off' only for local development
  gitName: process.env.GIT_NAME || 'latex editor',
  gitEmail: process.env.GIT_EMAIL || 'latex@localhost',
  // Login (see server/hash-password.js). AUTH=off only for local development.
  auth: process.env.AUTH !== 'off',
  authUser: process.env.AUTH_USER || '',
  authHash: process.env.AUTH_HASH || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  cookieSecure: process.env.COOKIE_SECURE !== 'off',
};

if (CONFIG.auth && (!CONFIG.authUser || !CONFIG.authHash || CONFIG.sessionSecret.length < 32)) {
  console.error('AUTH_USER, AUTH_HASH and SESSION_SECRET must be set (see server/hash-password.js).');
  process.exit(1);
}

const BUILD_DIR = 'build';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TEXT_FILE = 2 * 1024 * 1024;
const EDITABLE_EXT = new Set([
  '.tex', '.sty', '.cls', '.bib', '.bst', '.cfg', '.def', '.clo', '.fd',
  '.ltx', '.txt', '.md', '.csv',
]);
const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}$/;

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function docDir(doc) {
  if (typeof doc !== 'string' || !DOC_RE.test(doc)) throw new HttpError(400, 'invalid document name');
  return path.join(CONFIG.docsDir, doc);
}

// Validates a path coming from the browser. Rejects '..', absolute paths,
// hidden files (.git, .latexmkrc…) and the build directory.
function relPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) throw new HttpError(400, 'invalid path');
  const parts = p.split('/');
  if (parts.length > 8) throw new HttpError(400, 'path too deep');
  for (const part of parts) {
    if (!SEGMENT_RE.test(part)) throw new HttpError(400, `invalid path segment: ${part}`);
  }
  if (parts[0] === BUILD_DIR) throw new HttpError(400, 'the build directory is read-only');
  return parts.join('/');
}

// Resolves the real location of a file and checks it stays inside the document
// (protects against symlinks pointing elsewhere).
async function safeResolve(dir, rel, { mustExist }) {
  const realDir = await fsp.realpath(dir);
  const target = path.join(realDir, rel);
  let real;
  try {
    real = await fsp.realpath(target);
  } catch (err) {
    if (err.code !== 'ENOENT' || mustExist) throw new HttpError(404, 'file not found');
    const parentReal = await fsp.realpath(path.dirname(target)).catch(() => null);
    if (parentReal && !isInside(realDir, parentReal)) throw new HttpError(400, 'path escapes document');
    return target;
  }
  if (!isInside(realDir, real)) throw new HttpError(400, 'path escapes document');
  return real;
}

function isInside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

function isEditable(rel) {
  return EDITABLE_EXT.has(path.extname(rel).toLowerCase());
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// Runs a command, collects output, kills it after `timeoutMs`.
function run(cmd, args, { cwd, env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { if (out.length < 200000) out += d.toString('utf8'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: String(err), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}

// ---------------------------------------------------------------- documents

async function listDocs() {
  const entries = await fsp.readdir(CONFIG.docsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && DOC_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

// Latest modification time of the document's own files (not build/).
async function lastModified(dir) {
  let latest = 0;
  for (const f of await walk(dir)) {
    if (f.type !== 'file') continue;
    const st = await fsp.stat(path.join(dir, f.path)).catch(() => null);
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest;
}

async function docSummaries() {
  const out = [];
  for (const name of await listDocs()) {
    const dir = path.join(CONFIG.docsDir, name);
    const log = await gitLog(dir);
    out.push({ name, modified: await lastModified(dir), last: log[0] || null, commits: log.length });
  }
  return out;
}

const NEW_DOC_TEMPLATE = `\\documentclass[11pt]{article}
\\usepackage[a4paper, margin=2.5cm]{geometry}
\\usepackage[french]{babel}

% Everything above this line is precompiled once (faster previews).
% Load fonts (fontspec) below it: XeTeX cannot precompile them.
\\csname endofdump\\endcsname

\\usepackage{fontspec}
\\setmainfont{Linux Libertine O}

\\begin{document}

Bonjour.

\\end{document}
`;

async function createDoc(name, from) {
  const dir = docDir(name);
  if (fs.existsSync(dir)) throw new HttpError(409, 'a document with this name already exists');
  if (from) {
    const src = docDir(from);
    if (!fs.existsSync(src)) throw new HttpError(404, 'unknown source document');
    // copy the document's own files: no .git (fresh history), no build/, no hidden files
    await fsp.cp(src, dir, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p);
        if (!rel) return true;
        if (rel.split(path.sep).some((part) => part.startsWith('.'))) return false;
        return rel !== BUILD_DIR && !rel.startsWith(BUILD_DIR + path.sep);
      },
    });
  } else {
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'main.tex'), NEW_DOC_TEMPLATE);
  }
  return { ok: true, name };
}

async function walk(dir, prefix = '') {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!prefix && e.name === BUILD_DIR) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'dir' });
      out.push(...(await walk(path.join(dir, e.name), rel)));
    } else if (e.isFile()) {
      out.push({ path: rel, type: 'file', editable: isEditable(rel) });
    }
  }
  return out;
}

// The main file is main.tex if present, otherwise the first root .tex file
// containing an uncommented \documentclass.
async function findMain(dir) {
  const entries = (await fsp.readdir(dir)).filter((n) => n.endsWith('.tex')).sort();
  if (entries.includes('main.tex')) return 'main.tex';
  for (const name of entries) {
    const text = (await fsp.readFile(path.join(dir, name), 'utf8')).slice(0, 65536);
    if (/^[^%\n]*\\documentclass/m.test(text)) return name;
  }
  return null;
}

// ---------------------------------------------------------------- compilation
//
// Fast path (default): one xelatex run (+ reruns only when LaTeX asks for
// them), then xdvipdfmx. No latexmk: it costs time on every keystroke pause.
//
// Preamble cache (opt-in): if the main file contains the line
//     \csname endofdump\endcsname
// everything above it (class + packages) is precompiled once into
// build/preamble.fmt with mylatexformat, and rebuilt only when that part (or a
// file it \input's) changes. Fonts (fontspec) must be loaded *below* the line:
// XeTeX cannot store system fonts in a format.
//
// Documents with a .bib file go through latexmk (it knows how to run biber/bibtex).

const compileQueue = new Map(); // doc -> promise of the last compile
const lastFailed = new Set(); // docs whose last latexmk run failed
const MARKER_RE = /^[ \t]*\\(?:csname[ \t]+endofdump\\endcsname|endofdump)\b/m;
const BASE_FMT_CANDIDATES = [
  '/var/lib/texmf/web2c/xetex/xelatex.fmt', // Debian
  '/usr/share/texlive/texmf-var/web2c/xetex/xelatex.fmt',
];

function compileDoc(doc) {
  const prev = compileQueue.get(doc) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => runCompile(doc));
  compileQueue.set(doc, next);
  next.finally(() => { if (compileQueue.get(doc) === next) compileQueue.delete(doc); }).catch(() => {});
  return next;
}

function texEnv(home) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    TEXMFVAR: `${home}/texmf-var`,
    openin_any: 'p', // no reading outside the document (no absolute paths, no ..)
    openout_any: 'p', // same for writing
    shell_escape: 'f', // \write18 fully disabled
    max_print_line: '10000', // do not wrap log lines (easier to parse)
  };
}

function sandboxArgs(dir, hasGit, cmd) {
  const env = texEnv('/tmp');
  const args = [
    '--unshare-all', // no network, own PID/IPC/UTS namespaces
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/texmf', '/etc/texmf',
    '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/papersize', '/etc/papersize', // xdvipdfmx: default paper
    '--ro-bind-try', '/etc/paperspecs', '/etc/paperspecs', // xdvipdfmx: paper sizes (libpaper 2)
    '--ro-bind-try', '/var/lib/texmf', '/var/lib/texmf',
    '--ro-bind-try', '/var/cache/fontconfig', '/var/cache/fontconfig',
    '--bind', dir, '/work',
  ];
  if (hasGit) args.push('--ro-bind', path.join(dir, '.git'), '/work/.git');
  // no --proc: TeX does not need it, and it keeps bwrap compatible with systemd hardening
  args.push('--chdir', '/work', '--tmpfs', '/tmp', '--dev', '/dev');
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
  return [...args, ...cmd];
}

// Runs a command for a document: inside bubblewrap, or directly in dev mode.
function runTex(dir, cmd) {
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  return CONFIG.sandbox
    ? run('bwrap', sandboxArgs(dir, hasGit, cmd), { timeoutMs: CONFIG.compileTimeoutMs })
    : run(cmd[0], cmd.slice(1), { cwd: dir, env: texEnv(path.join(dir, BUILD_DIR, '.home')), timeoutMs: CONFIG.compileTimeoutMs });
}

// The shell script that runs inside the sandbox. Arguments: main file, base
// name, format name ('' for none). File names are validated before (SEGMENT_RE).
const FAST_SCRIPT = `
main="$1"; base="$2"; fmt="$3"
set -- -no-pdf -interaction=nonstopmode -file-line-error -synctex=1 -output-directory=${BUILD_DIR}
[ -n "$fmt" ] && set -- "$@" "-fmt=${BUILD_DIR}/$fmt"
rm -f "${BUILD_DIR}/$base.xdv"
xelatex "$@" "$main" > /dev/null 2>&1; code=$?
n=0
while [ $n -lt 3 ] && grep -qE 'Rerun to get|may have changed\\. Rerun|Rerun LaTeX' "${BUILD_DIR}/$base.log" 2>/dev/null; do
  xelatex "$@" "$main" > /dev/null 2>&1; code=$?; n=$((n + 1))
done
if [ -f "${BUILD_DIR}/$base.xdv" ]; then
  xdvipdfmx -q -o "${BUILD_DIR}/$base.pdf" "${BUILD_DIR}/$base.xdv" || exit 90
fi
exit $code
`;

const FORMAT_SCRIPT = `
xelatex -ini -interaction=nonstopmode -halt-on-error -recorder -jobname=preamble \
  -output-directory=${BUILD_DIR} "&xelatex" mylatexformat.ltx ${BUILD_DIR}/preamble-driver.tex > /dev/null 2>&1
`;

function sha1(text) {
  return require('node:crypto').createHash('sha1').update(text).digest('hex');
}

async function baseFormatStamp() {
  for (const p of BASE_FMT_CANDIDATES) {
    const st = await fsp.stat(p).catch(() => null);
    if (st) return `${p}:${st.mtimeMs}`;
  }
  return 'unknown';
}

// Returns 'preamble' when a valid preamble format is available (building it
// if needed), '' otherwise. `info.formatRebuilt` tells the UI it happened.
async function ensureFormat(dir, main, info) {
  const text = await fsp.readFile(path.join(dir, main), 'utf8');
  const m = MARKER_RE.exec(text);
  const build = path.join(dir, BUILD_DIR);
  const fmtFile = path.join(build, 'preamble.fmt');
  const keyFile = path.join(build, 'preamble.key');
  if (!m) return '';
  const preambleHash = sha1(text.slice(0, m.index));
  const stamp = await baseFormatStamp();

  // Same preamble text, same TeX Live, and no \input'ed file changed since?
  const key = await fsp.readFile(keyFile, 'utf8').then(JSON.parse).catch(() => null);
  const unchanged = async () => {
    for (const [rel, mtime] of Object.entries(key.inputs || {})) {
      const st = await fsp.stat(path.join(dir, rel)).catch(() => null);
      if (!st || st.mtimeMs !== mtime) return false;
    }
    return true;
  };
  if (key && key.stamp === stamp && key.inputs && await unchanged()) {
    if (key.preambleHash === preambleHash && fs.existsSync(fmtFile)) return 'preamble';
    if (key.failedHash === preambleHash) { // known to fail: do not retry until something changes
      info.formatError = key.error || 'unknown error';
      return '';
    }
  }

  // (Re)build. The driver preloads T1 so that the class does not load an
  // OpenType font (XeTeX cannot store those in a format); fontspec, below the
  // marker, switches back to Unicode fonts.
  await fsp.mkdir(build, { recursive: true });
  await fsp.rm(fmtFile, { force: true });
  await fsp.writeFile(path.join(build, 'preamble-driver.tex'), `\\RequirePackage[T1]{fontenc}\n${text}`);
  const started = Date.now();
  const r = await runTex(dir, ['sh', '-c', FORMAT_SCRIPT]);
  info.formatMs = Date.now() - started;
  // Remember every document file the preamble read, with its mtime.
  const fls = await fsp.readFile(path.join(build, 'preamble.fls'), 'utf8').catch(() => '');
  const inputs = {};
  for (const line of fls.split('\n')) {
    const f = /^INPUT (?:\.\/)?([^/\s][^\s]*)$/.exec(line);
    if (!f || f[1].startsWith(`${BUILD_DIR}/`) || f[1] === main) continue;
    const st = await fsp.stat(path.join(dir, f[1])).catch(() => null);
    if (st) inputs[f[1]] = st.mtimeMs;
  }
  if (r.code !== 0 || !fs.existsSync(fmtFile)) {
    const log = await fsp.readFile(path.join(build, 'preamble.log'), 'utf8').catch(() => '');
    const error = (/^! (.*)$/m.exec(log) || [])[1] || `exit code ${r.code}`;
    await fsp.rm(fmtFile, { force: true });
    await fsp.writeFile(keyFile, JSON.stringify({ failedHash: preambleHash, stamp, inputs, error }));
    info.formatError = error;
    return '';
  }
  await fsp.writeFile(keyFile, JSON.stringify({ preambleHash, stamp, inputs }));
  info.formatRebuilt = true;
  return 'preamble';
}

// "./config/commands.tex:12: Undefined control sequence." -> {file, line, message}
function parseErrors(log) {
  const errors = [];
  const seen = new Set();
  const lines = log.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\.\/)?([^:\n]+\.[A-Za-z]+):(\d+): (.*)$/.exec(lines[i]);
    if (m) {
      const file = m[2].replace(/^\/work\//, '');
      let message = m[4].trim();
      // add TeX's context line ("l.12 \foo") when present
      const ctx = lines.slice(i + 1, i + 6).find((l) => /^l\.\d+ /.test(l));
      if (ctx) message += `  —  ${ctx.replace(/^l\.\d+ /, '').trim()}`;
      const key = `${file}:${m[3]}:${m[4]}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ file, line: Number(m[3]), message }); }
    } else if (/^! /.test(lines[i])) {
      const message = lines[i].slice(2).trim();
      const key = `?:${message}`;
      if (!seen.has(key)) { seen.add(key); errors.push({ file: null, line: null, message }); }
    }
  }
  return errors.slice(0, 50);
}

async function hasBib(dir) {
  const files = await walk(dir);
  return files.some((f) => f.type === 'file' && f.path.endsWith('.bib'));
}

async function runCompile(doc) {
  const dir = docDir(doc);
  const main = await findMain(dir);
  if (!main) {
    return { ok: false, durationMs: 0, main: null, errors: [{ file: null, line: null, message: 'No main file: add main.tex, or a root .tex file with \\documentclass.' }] };
  }
  const base = main.replace(/\.tex$/, '');
  const pdfPath = path.join(dir, BUILD_DIR, `${base}.pdf`);
  const logPath = path.join(dir, BUILD_DIR, `${base}.log`);
  const before = await fsp.stat(pdfPath).then((s) => s.mtimeMs).catch(() => 0);
  await fsp.mkdir(path.join(dir, BUILD_DIR), { recursive: true });
  const info = {};
  const started = Date.now();
  let result;
  let mode;

  if (await hasBib(dir)) {
    mode = 'latexmk';
    const cmd = [
      'latexmk', '-norc', // -norc: never execute a latexmkrc (it is Perl code)
      '-xelatex', '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
      `-outdir=${BUILD_DIR}`,
    ];
    // after a failure, latexmk may think there is nothing to do: -g forces a run
    if (lastFailed.has(doc) || !before) cmd.push('-g');
    cmd.push(main);
    result = await runTex(dir, cmd);
    if (result.code === 0) lastFailed.delete(doc); else lastFailed.add(doc);
  } else {
    const fmt = await ensureFormat(dir, main, info);
    mode = fmt ? 'cached preamble' : 'fast';
    result = await runTex(dir, ['sh', '-c', FAST_SCRIPT, 'sh', main, base, fmt]);
    const log = await fsp.readFile(logPath, 'utf8').catch(() => '');
    if (fmt && result.code !== 0 && !/Output written on/.test(log)) {
      // The format may be stale or broken: drop it and compile normally.
      await fsp.rm(path.join(dir, BUILD_DIR, 'preamble.fmt'), { force: true });
      await fsp.rm(path.join(dir, BUILD_DIR, 'preamble.key'), { force: true });
      mode = 'fast (format dropped)';
      result = await runTex(dir, ['sh', '-c', FAST_SCRIPT, 'sh', main, base, '']);
    }
  }
  const durationMs = Date.now() - started;

  const log = await fsp.readFile(logPath, 'utf8').catch(() => '');
  const errors = parseErrors(log);
  const after = await fsp.stat(pdfPath).then((s) => s.mtimeMs).catch(() => 0);
  if (result.timedOut) errors.unshift({ file: null, line: null, message: `Compilation stopped after ${CONFIG.compileTimeoutMs / 1000} s.` });
  if (result.code === 90) errors.push({ file: null, line: null, message: 'xdvipdfmx could not produce the PDF.' });
  if (result.code !== 0 && errors.length === 0) {
    errors.push({ file: null, line: null, message: result.out.trim().split('\n').slice(-6).join('\n') || `compilation exited with code ${result.code}` });
  }
  const notes = [];
  if (info.formatError) {
    notes.push(`Preamble cache off: the part above \\csname endofdump\\endcsname could not be precompiled (${info.formatError}). `
      + 'Usually a font is loaded there: move fontspec, and packages that load OpenType fonts, below that line.');
  }
  return {
    ok: result.code === 0 && errors.length === 0,
    durationMs,
    mode,
    formatRebuilt: Boolean(info.formatRebuilt),
    notes,
    main,
    pdfUpdated: after > before,
    hasPdf: after > 0,
    errors,
  };
}

// ---------------------------------------------------------------- synctex
//
// Forward (code -> PDF) and backward (PDF -> code) search. The .synctex.gz file
// records paths as seen inside the sandbox (/work/...), so synctex runs there too.

function parseSynctex(out) {
  const records = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^(\w+):(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'Output') { cur = {}; records.push(cur); continue; }
    if (cur) cur[k] = v;
  }
  return records;
}

async function synctexView(dir, rel, line, column) {
  const main = await findMain(dir);
  if (!main) throw new HttpError(404, 'no main file');
  const pdf = `${BUILD_DIR}/${main.replace(/\.tex$/, '.pdf')}`;
  const r = await runTex(dir, ['synctex', 'view', '-i', `${line}:${column}:${rel}`, '-o', pdf]);
  const boxes = parseSynctex(r.out)
    .filter((b) => b.Page)
    .map((b) => ({ page: Number(b.Page), h: Number(b.h), v: Number(b.v), W: Number(b.W), H: Number(b.H), x: Number(b.x), y: Number(b.y) }))
    .slice(0, 20);
  return { boxes };
}

async function synctexEdit(dir, page, x, y) {
  const main = await findMain(dir);
  if (!main) throw new HttpError(404, 'no main file');
  const pdf = `${BUILD_DIR}/${main.replace(/\.tex$/, '.pdf')}`;
  const r = await runTex(dir, ['synctex', 'edit', '-o', `${page}:${x}:${y}:${pdf}`]);
  const rec = parseSynctex(r.out).find((b) => b.Input);
  if (!rec) return { found: false };
  const file = rec.Input.replace(/^\/work\//, '').replace(/^(\.\/)+/, '');
  if (file.startsWith('/')) return { found: false }; // a system file (package), not ours
  return { found: true, file, line: Number(rec.Line) || 1, column: Math.max(0, Number(rec.Column) || 0) };
}

// ---------------------------------------------------------------- git

function gitEnv() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: CONFIG.docsDir,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(dir, args) {
  const base = [
    '-c', 'core.hooksPath=/dev/null', // never run hooks
    '-c', `user.name=${CONFIG.gitName}`,
    '-c', `user.email=${CONFIG.gitEmail}`,
    '-c', 'init.defaultBranch=main',
  ];
  return run('git', [...base, ...args], { cwd: dir, env: gitEnv() });
}

async function ensureRepo(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return;
  await git(dir, ['init', '-q']);
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) await fsp.writeFile(gi, `${BUILD_DIR}/\n*.aux\n*.log\n*.out\n*.xdv\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n.DS_Store\n`);
}

// Uncommitted changes, file by file: M modified, A added, D deleted, U untracked, R renamed.
async function gitStatus(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const files = (await walk(dir)).filter((f) => f.type === 'file').map((f) => ({ code: 'U', path: f.path }));
    return { repo: false, changes: files.length, files, last: null };
  }
  const r = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  const files = r.out.split('\n').filter(Boolean).map((line) => {
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"(.*)"$/, '$1');
    const code = xy === '??' ? 'U' : (xy.trim()[0] || 'M');
    return { code, path: p };
  });
  const last = await git(dir, ['log', '-1', '--format=%h %s (%cr)']);
  return { repo: true, changes: files.length, files, last: last.code === 0 ? last.out.trim() : null };
}

const HASH_RE = /^[0-9a-f]{7,40}$/;
const FIELD = '\x1f';

async function gitLog(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const r = await git(dir, ['log', '-n', '300', `--format=%H${FIELD}%h${FIELD}%cI${FIELD}%cr${FIELD}%s`]);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((line) => {
    const [hash, short, date, relative, subject] = line.split(FIELD);
    return { hash, short, date, relative, subject };
  });
}

async function checkCommit(dir, hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new HttpError(400, 'invalid commit hash');
  const r = await git(dir, ['cat-file', '-e', `${hash}^{commit}`]);
  if (r.code !== 0) throw new HttpError(404, 'unknown commit');
}

async function gitShow(dir, hash) {
  await checkCommit(dir, hash);
  const r = await git(dir, ['show', '--no-color', '--stat', '--patch', '--format=%h  %s%n%cd%n', '--date=format:%Y-%m-%d %H:%M', hash]);
  return { hash, patch: r.out.length >= 199000 ? `${r.out}\n… (truncated)` : r.out };
}

// Brings the files back to their state at `hash`. History is kept: the
// restored state shows up as uncommitted changes, to be committed by hand.
async function gitRestore(dir, hash, force) {
  await checkCommit(dir, hash);
  const st = await gitStatus(dir);
  if (st.changes && !force) throw new HttpError(409, `${st.changes} uncommitted change(s) would be lost`);
  const r = await git(dir, ['restore', `--source=${hash}`, '--staged', '--worktree', '--', '.']);
  if (r.code !== 0) throw new HttpError(500, r.out.trim() || 'git restore failed');
  return { ok: true };
}

async function gitCommit(dir, message) {
  await ensureRepo(dir);
  await git(dir, ['add', '-A']);
  const r = await git(dir, ['commit', '-q', '-m', message]);
  if (r.code !== 0) {
    if (/nothing to commit|nothing added/.test(r.out)) return { ok: true, nothing: true };
    throw new HttpError(500, r.out.trim() || 'git commit failed');
  }
  const h = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, hash: h.out.trim() };
}

// ---------------------------------------------------------------- login
//
// One user. The password is checked against an scrypt hash; a successful login
// sets a signed cookie "<expiry>.<hmac>" (HttpOnly, Secure, SameSite=Lax).
// Nothing is stored server-side: changing SESSION_SECRET logs everyone out.

const crypto = require('node:crypto');
const COOKIE = 'latex_session';
const failures = new Map(); // ip -> { count, since }
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

function hmac(text) {
  return crypto.createHmac('sha256', CONFIG.sessionSecret).update(text).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function checkPassword(user, password) {
  const [kind, N, r, p, salt, hash] = CONFIG.authHash.split(':');
  if (kind !== 'scrypt' || typeof password !== 'string' || password.length > 1024) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  const passOk = crypto.timingSafeEqual(got, expected);
  return safeEqual(user, CONFIG.authUser) && passOk;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isLoggedIn(req) {
  if (!CONFIG.auth) return true;
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(`${CONFIG.authUser}|${exp}`));
}

function sessionCookie(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${CONFIG.cookieSecure ? '; Secure' : ''}`;
}

function clientIp(req) {
  // Caddy sets X-Forwarded-For; the server only listens on 127.0.0.1.
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

async function serveLogin(res, error) {
  let html = await fsp.readFile(path.join(CONFIG.publicDir, 'login.html'), 'utf8');
  const messages = {
    1: 'Wrong name or password.',
    2: 'Too many attempts. Try again in a quarter of an hour.',
  };
  if (messages[error]) html = html.replace('<!--error-->', `<p class="error">${messages[error]}</p>`);
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
  res.end(html);
}

async function handleLogin(req, res) {
  // the form must come from this site
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'cross-site login');
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && Date.now() - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
  if ((failures.get(ip) || {}).count >= MAX_FAILURES) return redirect(res, '/login?error=2');

  const form = new URLSearchParams((await readBody(req)).toString('utf8'));
  if (checkPassword(form.get('user') || '', form.get('password') || '')) {
    failures.delete(ip);
    const exp = Date.now() + CONFIG.sessionDays * 86400 * 1000;
    return redirect(res, '/', { 'Set-Cookie': sessionCookie(`${exp}.${hmac(`${CONFIG.authUser}|${exp}`)}`, CONFIG.sessionDays * 86400) });
  }
  const entry = failures.get(ip) || { count: 0, since: Date.now() };
  entry.count += 1;
  failures.set(ip, entry);
  console.warn(`login failed from ${ip} (${entry.count})`);
  await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
  return redirect(res, '/login?error=1');
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^(fonts\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(rel)) throw new HttpError(404, 'not found');
  const file = path.join(CONFIG.publicDir, rel);
  const data = await fsp.readFile(file).catch(() => { throw new HttpError(404, 'not found'); });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
    'Cache-Control': rel === 'index.html' ? 'no-cache' : rel.startsWith('fonts/') ? 'public, max-age=604800' : 'public, max-age=300',
    'Content-Security-Policy': CSP,
  });
  res.end(data);
}

// ---------------------------------------------------------------- routes

async function handleApi(req, res, url) {
  // Anti-CSRF: every write must carry a custom header (a foreign site cannot
  // send it without a CORS preflight, which we never answer).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-editor'] !== '1') throw new HttpError(403, 'missing X-Editor header');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'cross-site request');
  }

  const parts = url.pathname.split('/').filter(Boolean); // api, docs, <doc>, <action>
  if (parts.length === 2 && parts[1] === 'docs' && req.method === 'GET') {
    return sendJson(res, 200, { docs: await docSummaries() });
  }
  if (parts.length === 2 && parts[1] === 'docs' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await createDoc(body.name, body.from || null));
  }
  if (parts.length !== 4 || parts[1] !== 'docs') throw new HttpError(404, 'not found');
  const doc = decodeURIComponent(parts[2]);
  const dir = docDir(doc);
  if (!fs.existsSync(dir)) throw new HttpError(404, 'unknown document');
  const action = parts[3];

  if (action === 'tree' && req.method === 'GET') {
    return sendJson(res, 200, { doc, main: await findMain(dir), files: await walk(dir) });
  }

  if (action === 'file') {
    const rel = relPath(url.searchParams.get('path'));
    if (req.method === 'GET') {
      if (!isEditable(rel)) throw new HttpError(415, 'not a text file');
      const file = await safeResolve(dir, rel, { mustExist: true });
      const st = await fsp.stat(file);
      if (st.size > MAX_TEXT_FILE) throw new HttpError(413, 'file too large');
      return sendJson(res, 200, { path: rel, content: await fsp.readFile(file, 'utf8') });
    }
    if (req.method === 'PUT') {
      if (!isEditable(rel)) throw new HttpError(415, 'only text files can be edited');
      const body = await readJson(req);
      if (typeof body.content !== 'string') throw new HttpError(400, 'content missing');
      if (Buffer.byteLength(body.content) > MAX_TEXT_FILE) throw new HttpError(413, 'file too large');
      const file = await safeResolve(dir, rel, { mustExist: !body.create });
      if (body.create && fs.existsSync(file)) throw new HttpError(409, 'file already exists');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, body.content, 'utf8');
      await fsp.rename(tmp, file); // atomic replace
      return sendJson(res, 200, { ok: true });
    }
  }

  if (action === 'compile' && req.method === 'POST') {
    return sendJson(res, 200, await compileDoc(doc));
  }

  if (action === 'pdf' && req.method === 'GET') {
    const main = await findMain(dir);
    if (!main) throw new HttpError(404, 'no main file');
    const pdf = path.join(dir, BUILD_DIR, main.replace(/\.tex$/, '.pdf'));
    const data = await fsp.readFile(pdf).catch(() => { throw new HttpError(404, 'no PDF yet'); });
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
    return res.end(data);
  }

  if (action === 'status' && req.method === 'GET') {
    return sendJson(res, 200, await gitStatus(dir));
  }

  if (action === 'rename' && req.method === 'POST') {
    const body = await readJson(req);
    const target = docDir(body.name);
    if (fs.existsSync(target)) throw new HttpError(409, 'a project with this name already exists');
    await (compileQueue.get(doc) || Promise.resolve()).catch(() => {}); // let a running compile finish
    await fsp.rename(dir, target);
    lastFailed.delete(doc);
    return sendJson(res, 200, { ok: true, name: body.name });
  }

  if (action === 'mkdir' && req.method === 'POST') {
    const body = await readJson(req);
    const rel = relPath(body.path);
    const target = await safeResolve(dir, rel, { mustExist: false });
    if (fs.existsSync(target)) throw new HttpError(409, 'already exists');
    await fsp.mkdir(target, { recursive: true });
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'sync-view' && req.method === 'GET') {
    const rel = relPath(url.searchParams.get('path'));
    const line = Number(url.searchParams.get('line'));
    const column = Number(url.searchParams.get('column') || 0);
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0) throw new HttpError(400, 'invalid position');
    return sendJson(res, 200, await synctexView(dir, rel, line, column));
  }

  if (action === 'sync-edit' && req.method === 'GET') {
    const page = Number(url.searchParams.get('page'));
    const x = Number(url.searchParams.get('x'));
    const y = Number(url.searchParams.get('y'));
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'invalid position');
    return sendJson(res, 200, await synctexEdit(dir, page, x.toFixed(2), y.toFixed(2)));
  }

  if (action === 'log' && req.method === 'GET') {
    return sendJson(res, 200, { commits: await gitLog(dir), status: await gitStatus(dir) });
  }

  if (action === 'show' && req.method === 'GET') {
    return sendJson(res, 200, await gitShow(dir, url.searchParams.get('hash')));
  }

  if (action === 'restore' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await gitRestore(dir, body.hash, Boolean(body.force)));
  }

  if (action === 'commit' && req.method === 'POST') {
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 500) throw new HttpError(400, 'commit message required (max 500 chars)');
    return sendJson(res, 200, await gitCommit(dir, message));
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    const p = url.pathname;
    // public: the login page and what it needs
    if (p === '/login' && req.method === 'GET') {
      if (isLoggedIn(req)) return redirect(res, '/');
      return await serveLogin(res, url.searchParams.get('error'));
    }
    if (p === '/login' && req.method === 'POST') return await handleLogin(req, res);
    if (req.method === 'GET' && (p === '/login.css' || p === '/favicon.svg')) return await serveStatic(req, res, p);

    // everything else needs a session
    if (!isLoggedIn(req)) {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return redirect(res, '/login');
      throw new HttpError(401, 'not logged in');
    }
    if (p === '/api/logout' && req.method === 'POST') {
      if (req.headers['x-editor'] !== '1') throw new HttpError(403, 'missing X-Editor header');
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return sendJson(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') await serveStatic(req, res, p);
    else throw new HttpError(405, 'method not allowed');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`latex editor on http://${CONFIG.host}:${CONFIG.port} — docs: ${CONFIG.docsDir} — sandbox: ${CONFIG.sandbox ? 'bwrap' : 'OFF'} — login: ${CONFIG.auth ? CONFIG.authUser : 'OFF'}`);
});
