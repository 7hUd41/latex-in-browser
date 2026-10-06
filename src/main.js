// latex.thudal.com — editor front-end.
//
// Two screens: the project list (#) and the editor (#<project>/<file>).
// Editor, VS Code style: sidebar (files | versioning) · CodeMirror (vim) · PDF,
// and a status bar at the bottom.
// Every pause in typing saves the changed files and recompiles.
// :w saves and compiles immediately. Commits are manual (versioning tab or :commit msg).

import { Vim, getCM } from '@replit/codemirror-vim';
import { setDiagnostics } from '@codemirror/lint';
import { EditorState, EditorView, editorExtensions } from './editor.js';
import { PdfView } from './pdfview.js';
import { api } from './api.js';

// ---------------------------------------------------------------- prefs (per browser)

const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`latex.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`latex.${key}`, JSON.stringify(value)); } catch { /* private mode: ignore */ }
  },
};

// ---------------------------------------------------------------- state

const S = {
  doc: null,
  main: null,
  files: [], // [{path, type, editable}]
  buffers: new Map(), // path -> { state, dirty }
  current: null,
  errors: [],
  notes: [],
  compiling: false,
  pending: false,
  timer: null,
  delay: prefs.get('delay', 800),
  collapsed: new Set(prefs.get('collapsed', [])),
  showTree: prefs.get('showTree', true),
  selected: null, // selected path in the tree (file or folder)
  creating: null, // { kind: 'file' | 'folder', in: folder path ('' = root) } while naming
  draft: '',
  leftTab: 'files',
  commits: [],
  changes: [], // uncommitted files [{code, path}]
  viewedCommit: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  homeView: $('home-view'),
  editorView: $('editor-view'),
  projects: $('projects'),
  newProject: $('new-project'),
  newName: $('new-name'),
  newFrom: $('new-from'),
  cols: $('cols'),
  docName: $('doc-name'),
  tree: $('tree'),
  filesPane: $('files-pane'),
  scmPane: $('scm-pane'),
  commitMsg: $('commit-msg'),
  commitBtn: $('commit-btn'),
  changesList: $('changes'),
  changesCount: $('changes-count'),
  history: $('history'),
  problems: $('problems'),
  commitView: $('commit-view'),
  commitTitle: $('commit-title'),
  commitPatch: $('commit-patch'),
  delay: $('delay'),
  sbErrors: $('sb-errors'),
  sbNotes: $('sb-notes'),
  sbVim: $('sb-vim'),
  sbKeys: $('sb-keys'),
  sbStatus: $('sb-status'),
  sbChanges: $('sb-changes-n'),
  gearMenu: $('gear-menu'),
  toast: $('toast'),
};

// ---------------------------------------------------------------- editor + preview

const extensions = editorExtensions({
  onChange: () => {
    const buf = S.buffers.get(S.current);
    if (!buf) return;
    buf.dirty = true;
    renderDirty();
    schedule();
  },
  onSaveKey: () => flush(),
  onSyncKey: () => syncToPdf(),
  onCursor: () => {},
  onOpenAt: (pos, anywhere) => openIncludedFile(pos, anywhere),
});

// \input{content/x.tex} under the cursor (or anywhere on the line for gf):
// open that file. Returns true when a file reference was found.
const INCLUDE_RE = /\\(input|include|subfile|InputIfFileExists|includeonly)\s*\{([^}]+)\}/g;
function openIncludedFile(pos, anywhere) {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  let target = null;
  for (const m of line.text.matchAll(INCLUDE_RE)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (anywhere ? !target : col >= start && col <= end) target = m[2].trim();
  }
  if (!target) return false;
  let path = target.replace(/^\.\//, '');
  if (!/\.[A-Za-z]+$/.test(path)) path += '.tex';
  if (S.files.some((f) => f.path === path && f.editable)) openFile(path);
  else toast(`File not found in the project: ${path}`, 'error');
  return true;
}
Vim.defineAction('openIncludedFile', (cm) => {
  if (!openIncludedFile(view.state.selection.main.head, true)) toast('No \\input{…} on this line.');
});
Vim.mapCommand('gf', 'action', 'openIncludedFile', {}, { context: 'normal' });

const view = new EditorView({
  parent: $('editor'),
  state: EditorState.create({ doc: '', extensions: [...extensions, EditorState.readOnly.of(true)] }),
});

const pdf = new PdfView($('pdf'), {
  onSyncClick: (pos) => syncToCode(pos),
  onLayout: () => applyWidths(),
  mode: prefs.get('pdfMode', 'page'),
});

// Vim mode and pending keys go to the status bar (like VS Code). The vim
// object changes with every file (setState), so listeners are re-attached.
const watchedCMs = new WeakSet();
function watchVim() {
  const cm = getCM(view);
  if (!cm || watchedCMs.has(cm)) return;
  watchedCMs.add(cm);
  cm.on('vim-mode-change', (e) => {
    const mode = e.mode === 'visual' && e.subMode ? `visual ${e.subMode}` : e.mode;
    el.sbVim.textContent = String(mode).toUpperCase();
    el.sbVim.dataset.mode = e.mode;
    el.sbKeys.textContent = '';
  });
  let clearKeys;
  cm.on('vim-keypress', (key) => {
    clearTimeout(clearKeys);
    if (key === '<Esc>' || key === '<C-[>') { el.sbKeys.textContent = ''; return; }
    el.sbKeys.textContent = (el.sbKeys.textContent + key).slice(-12);
    clearKeys = setTimeout(() => { el.sbKeys.textContent = ''; }, 1200);
  });
  cm.on('vim-command-done', () => { el.sbKeys.textContent = ''; });
}

// ---------------------------------------------------------------- SyncTeX

async function syncToPdf() {
  if (!S.doc || !S.current) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head).number;
  try {
    const { boxes } = await api.syncView(S.doc, S.current, line, 0);
    if (!pdf.showBoxes(boxes)) toast('No position in the PDF for this line.');
  } catch (err) {
    toast(`Sync failed — ${err.message}`, 'error');
  }
}

async function syncToCode(pos) {
  if (!S.doc) return;
  try {
    const r = await api.syncEdit(S.doc, pos.page, pos.x, pos.y);
    if (!r.found || !S.files.some((f) => f.path === r.file && f.editable)) {
      toast('No source position here.');
      return;
    }
    await openFile(r.file, r.line);
  } catch (err) {
    toast(`Sync failed — ${err.message}`, 'error');
  }
}

Vim.defineEx('write', 'w', () => flush());
Vim.defineEx('commit', 'commit', (_cm, params) => {
  const msg = (params.argString || '').trim();
  if (msg) commit(msg); else openVersioning(true);
});
Vim.defineEx('tree', 'tree', () => toggleTree());
Vim.defineEx('sync', 'sync', () => syncToPdf());
Vim.defineEx('versioning', 'vers', () => setLeftTab(S.leftTab === 'versioning' ? 'files' : 'versioning'));

// ---------------------------------------------------------------- small UI helpers

// Messages go to the status bar in the editor, to a floating toast elsewhere.
let toastTimer;
function toast(text, kind = '') {
  clearTimeout(toastTimer);
  if (!el.editorView.hidden) {
    const m = $('sb-message');
    m.textContent = text;
    m.title = text;
    m.className = `sb-message show ${kind}`;
    toastTimer = setTimeout(() => { m.className = 'sb-message'; }, kind === 'error' ? 8000 : 4000);
    return;
  }
  el.toast.textContent = text;
  el.toast.className = `toast show ${kind}`;
  toastTimer = setTimeout(() => { el.toast.className = 'toast'; }, 3500);
}

function setStatus(text, kind, title = '') {
  el.sbStatus.textContent = text;
  el.sbStatus.className = `sb-item status ${kind || ''}`;
  el.sbStatus.title = title;
}

function anyDirty() {
  for (const b of S.buffers.values()) if (b.dirty) return true;
  return false;
}

function renderDirty() {
  for (const li of el.tree.querySelectorAll('[data-path]')) {
    const b = S.buffers.get(li.dataset.path);
    li.classList.toggle('dirty', Boolean(b && b.dirty));
  }
}

function fileHash(doc, path) {
  return `#${encodeURIComponent(doc)}/${path ? path.split('/').map(encodeURIComponent).join('/') : ''}`;
}

function updateHash() {
  const h = fileHash(S.doc, S.current);
  if (location.hash !== h) history.replaceState(null, '', h);
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

// ---------------------------------------------------------------- theme, logout, gear menu

// Theme ("code" = VS Code-like, "thudal" = thudal.com) and appearance (light / dark).
function markLook() {
  const root = document.documentElement;
  for (const b of el.gearMenu.querySelectorAll('[data-action="theme"]')) b.classList.toggle('active', b.dataset.value === root.dataset.theme);
  for (const b of el.gearMenu.querySelectorAll('[data-action="mode"]')) b.classList.toggle('active', b.dataset.value === root.dataset.mode);
}
function setLook({ theme, mode }) {
  const root = document.documentElement;
  if (theme) { root.dataset.theme = theme; prefs.set('theme', theme); }
  if (mode) { root.dataset.mode = mode; prefs.set('mode', mode); }
  markLook();
  recolorPdf();
  applyWidths();
}

// Dark mode: the preview gets the theme's paper and ink (a duotone filter on the
// rendered pages). The PDF itself, and the download, keep their normal colours.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? m.slice(1).map((h) => parseInt(h, 16) / 255) : null;
}
function recolorPdf() {
  const css = getComputedStyle(document.documentElement);
  const paper = hexToRgb(css.getPropertyValue('--pdf-paper'));
  const ink = hexToRgb(css.getPropertyValue('--pdf-ink'));
  const on = document.documentElement.dataset.mode === 'dark' && paper && ink;
  $('pdf').classList.toggle('recolor', Boolean(on));
  if (!on) return;
  ['pdf-r', 'pdf-g', 'pdf-b'].forEach((id, i) => {
    $(id).setAttribute('tableValues', `${ink[i].toFixed(4)} ${paper[i].toFixed(4)}`); // black -> ink, white -> paper
  });
}
markLook();
recolorPdf();

$('download-btn').addEventListener('click', (e) => {
  e.preventDefault();
  if (!S.doc || !pdf.data) { toast('No PDF yet.'); return; }
  const blob = new Blob([pdf.data], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.doc}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
// The project's sources: save first, so the archive has the latest edits.
$('archive-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!S.doc) return;
  await flush();
  const a = document.createElement('a');
  a.href = api.archiveUrl(S.doc);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
});
function toggleMode() {
  setLook({ mode: document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark' });
}

async function logout() {
  await flush();
  try { await api.logout(); } catch { /* ignore */ }
  location.href = '/login';
}

$('home-theme').addEventListener('click', toggleMode);
$('home-logout').addEventListener('click', logout);

$('gear-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  el.gearMenu.hidden = !el.gearMenu.hidden;
});
el.gearMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return; // the delay field
  const action = btn.dataset.action;
  if (action === 'engine') return; // only XeLaTeX for now
  if (action === 'theme') { setLook({ theme: btn.dataset.value }); return; }
  if (action === 'mode') { setLook({ mode: btn.dataset.value }); return; }
  el.gearMenu.hidden = true;
  if (action === 'projects') location.hash = '';
  if (action === 'logout') logout();
});
document.addEventListener('click', (e) => {
  if (!el.gearMenu.hidden && !el.gearMenu.contains(e.target)) el.gearMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') el.gearMenu.hidden = true;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !el.editorView.hidden) {
    e.preventDefault();
    toggleTree();
  }
});

// ---------------------------------------------------------------- screens

function showScreen(name) {
  el.homeView.hidden = name !== 'home';
  el.editorView.hidden = name !== 'editor';
}

async function route() {
  const raw = location.hash.slice(1);
  if (!raw) {
    if (S.doc) await leaveDoc();
    return showHome();
  }
  const [docPart, ...pathParts] = raw.split('/');
  const doc = decodeURIComponent(docPart);
  const file = pathParts.map(decodeURIComponent).join('/') || null;
  if (doc === S.doc) {
    if (file && file !== S.current) openFile(file);
    return;
  }
  if (S.doc) await leaveDoc();
  await loadDoc(doc, file);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- home: project list

async function showHome() {
  showScreen('home');
  document.title = 'latex.thudal';
  let docs;
  try {
    ({ docs } = await api.docs());
  } catch (err) {
    toast(`Server unreachable: ${err.message}`, 'error');
    return;
  }
  el.projects.textContent = '';
  el.newFrom.length = 1; // keep "empty document"
  for (const d of docs) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.name;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = d.modified ? `edited ${timeAgo(d.modified)}` : '';
    const last = document.createElement('span');
    last.className = 'last';
    last.textContent = d.last
      ? `${d.commits} commit${d.commits > 1 ? 's' : ''} · last: ${d.last.subject} (${d.last.relative})`
      : 'no commit yet';
    li.append(name, when, last);
    li.addEventListener('click', () => { location.hash = fileHash(d.name, ''); });
    el.projects.appendChild(li);

    const o = document.createElement('option');
    o.value = d.name;
    o.textContent = `copy of ${d.name}`;
    el.newFrom.appendChild(o);
  }
  if (!docs.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No project yet.';
    el.projects.appendChild(li);
  }
}

el.newProject.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.newName.value.trim();
  if (!name) return;
  try {
    await api.create(name, el.newFrom.value || null);
    el.newName.value = '';
    location.hash = fileHash(name, '');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------------------------------------------------------------- tree

function isHidden(path) {
  const parent = path.split('/').slice(0, -1);
  for (let i = 1; i <= parent.length; i++) if (S.collapsed.has(parent.slice(0, i).join('/'))) return true;
  return false;
}

// Click a folder to select it and open/close it, click a file to open it.
// New file / new folder go into the selected folder (or next to the selected
// file), named in an inline input right under that folder, like VS Code.
function renderTree() {
  el.tree.textContent = '';
  const errorFiles = new Set(S.errors.map((e) => e.file).filter(Boolean));
  const changed = new Map(S.changes.map((c) => [c.path, c.code]));
  const creatingIn = S.creating ? S.creating.in : null;
  if (creatingIn === '') el.tree.appendChild(nameRow(0));
  for (const f of S.files) {
    if (isHidden(f.path)) continue;
    const depth = f.path.split('/').length - 1;
    const li = document.createElement('li');
    li.style.setProperty('--depth', depth);
    const name = f.path.split('/').pop();
    if (f.path === S.selected) li.classList.add('selected');
    if (f.type === 'dir') {
      li.classList.add('dir', S.collapsed.has(f.path) ? 'closed' : 'open');
      const dirLabel = document.createElement('span');
      dirLabel.className = 'label';
      dirLabel.textContent = name;
      li.appendChild(dirLabel);
      li.addEventListener('click', () => {
        S.selected = f.path;
        if (S.collapsed.has(f.path)) S.collapsed.delete(f.path); else S.collapsed.add(f.path);
        prefs.set('collapsed', [...S.collapsed]);
        renderTree();
      });
      el.tree.appendChild(li);
      if (creatingIn === f.path) el.tree.appendChild(nameRow(depth + 1));
      continue;
    }
    li.dataset.path = f.path;
    li.classList.add('file');
    if (!f.editable) li.classList.add('binary');
    if (f.path === S.current) li.classList.add('current');
    if (f.path === S.main) li.classList.add('main');
    if (errorFiles.has(f.path)) li.classList.add('has-error');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    li.appendChild(label);
    if (changed.has(f.path)) {
      const badge = document.createElement('span');
      badge.className = `vcs vcs-${changed.get(f.path)}`;
      badge.textContent = changed.get(f.path);
      li.appendChild(badge);
    }
    li.title = f.editable ? f.path + (f.path === S.main ? ' (main file: compilation starts here)' : '') : `${f.path} (not editable here)`;
    li.addEventListener('click', () => {
      S.selected = f.path;
      if (f.editable) openFile(f.path); else renderTree();
    });
    el.tree.appendChild(li);
  }
  renderDirty();
  const input = el.tree.querySelector('.naming input');
  if (input && document.activeElement !== input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// Inline input to name a new file or folder.
function nameRow(depth) {
  const li = document.createElement('li');
  li.className = `naming ${S.creating.kind}`;
  li.style.setProperty('--depth', depth);
  const input = document.createElement('input');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = S.draft || '';
  input.addEventListener('input', () => { S.draft = input.value; });
  let done = false;
  const cancel = () => {
    if (done || !input.isConnected) return; // re-rendered meanwhile: the new row takes over
    done = true;
    S.creating = null;
    S.draft = '';
    renderTree();
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); view.focus(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = input.value.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return cancel();
    const { kind } = S.creating;
    const path = S.creating.in ? `${S.creating.in}/${name}` : name;
    done = true;
    try {
      if (kind === 'folder') await api.mkdir(S.doc, path);
      else await api.write(S.doc, path, '', true);
      S.creating = null;
      S.draft = '';
      await refreshTree();
      S.selected = path;
      if (kind === 'file') await openFile(path);
      else { S.collapsed.delete(path); renderTree(); }
    } catch (err) {
      done = false;
      toast(err.message, 'error');
      input.focus();
    }
  });
  input.addEventListener('blur', () => setTimeout(cancel, 150));
  li.appendChild(input);
  return li;
}

function startCreating(kind) {
  if (S.leftTab !== 'files') setLeftTab('files');
  const sel = S.files.find((f) => f.path === S.selected);
  let folder = '';
  if (sel && sel.type === 'dir') folder = sel.path;
  else if (sel) folder = sel.path.split('/').slice(0, -1).join('/');
  if (folder) {
    // make sure the folder and its parents are open
    const parts = folder.split('/');
    for (let i = 1; i <= parts.length; i++) S.collapsed.delete(parts.slice(0, i).join('/'));
    prefs.set('collapsed', [...S.collapsed]);
  }
  S.creating = { kind, in: folder };
  S.draft = '';
  renderTree();
}
// Click the project name to rename it.
el.docName.addEventListener('click', () => {
  if (!S.doc || el.docName.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = S.doc;
  input.spellcheck = false;
  el.docName.textContent = '';
  el.docName.appendChild(input);
  el.docName.parentElement.classList.add('renaming');
  input.focus();
  input.select();
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    el.docName.textContent = S.doc;
    el.docName.parentElement.classList.remove('renaming');
  };
  input.addEventListener('blur', restore);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); restore(); view.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === S.doc) { restore(); return; }
    done = true;
    try {
      await flush(); // save under the old name first
      await api.rename(S.doc, name);
      const file = S.current;
      S.doc = null; // nothing left to save under the old name
      el.docName.parentElement.classList.remove('renaming');
      toast(`Project renamed to ${name}`, 'ok');
      location.hash = fileHash(name, file);
    } catch (err) {
      done = false;
      toast(`Rename failed — ${err.message}`, 'error');
      input.focus();
    }
  });
});

$('new-file').addEventListener('click', () => startCreating('file'));
$('new-folder').addEventListener('click', () => startCreating('folder'));
$('refresh').addEventListener('click', async () => {
  try { await refreshTree(); refreshGit(); } catch (err) { toast(err.message, 'error'); }
});

function applyTreeVisibility() {
  el.cols.classList.toggle('no-tree', !S.showTree);
  $('statusbar').classList.toggle('no-tree', !S.showTree);
  // settings / sidebar / versioning sit under the tree, or under the editor when it is hidden
  (S.showTree ? $('sb-tree') : $('sb-editor')).prepend($('sb-side'));
  if (S.showTree) $('sb-tree').append($('archive-btn')); else $('sb-side').after($('archive-btn'));
}
function toggleTree() {
  S.showTree = !S.showTree;
  prefs.set('showTree', S.showTree);
  applyTreeVisibility();
  applyWidths();
}
for (const b of document.querySelectorAll('[data-action="toggle-tree"]')) {
  b.addEventListener('click', () => { toggleTree(); view.focus(); });
}
applyTreeVisibility();

// ---------------------------------------------------------------- files

async function openFile(path, line) {
  closeCommitView();
  if (S.current && S.buffers.has(S.current)) S.buffers.get(S.current).state = view.state;
  let buf = S.buffers.get(path);
  if (!buf) {
    try {
      const { content } = await api.read(S.doc, path);
      buf = { state: EditorState.create({ doc: content, extensions }), dirty: false };
      S.buffers.set(path, buf);
    } catch (err) {
      toast(`Cannot open ${path}: ${err.message}`, 'error');
      return;
    }
  }
  S.current = path;
  S.selected = path;
  view.setState(buf.state);
  watchVim();
  el.sbVim.textContent = 'NORMAL';
  el.sbVim.dataset.mode = 'normal';
  applyDiagnostics();
  renderTree();
  updateHash();
  if (line) goToLine(line);
  view.focus();
}

function goToLine(line) {
  const doc = view.state.doc;
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
  view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
}

async function saveDirty() {
  if (S.current && S.buffers.has(S.current)) S.buffers.get(S.current).state = view.state;
  const jobs = [];
  for (const [path, buf] of S.buffers) {
    if (!buf.dirty) continue;
    const content = buf.state.doc.toString();
    buf.dirty = false; // edits made during the save will set it again
    jobs.push(api.write(S.doc, path, content).catch((err) => {
      buf.dirty = true;
      throw new Error(`${path}: ${err.message}`);
    }));
  }
  const results = await Promise.allSettled(jobs);
  renderDirty();
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return jobs.length;
}

// ---------------------------------------------------------------- save + compile loop

function schedule() {
  clearTimeout(S.timer);
  S.timer = setTimeout(flush, S.delay);
}

async function flush() {
  clearTimeout(S.timer);
  S.timer = null;
  if (!S.doc) return;
  if (S.compiling) { S.pending = true; return; }
  try {
    await saveDirty();
  } catch (err) {
    setStatus('save failed', 'error');
    toast(`Save failed — ${err.message}`, 'error');
    return;
  }
  await compile();
}

async function compile() {
  const doc = S.doc;
  S.compiling = true;
  setStatus('compiling…', 'busy');
  let res;
  try {
    res = await api.compile(doc);
  } catch (err) {
    S.compiling = false;
    setStatus('compile failed', 'error');
    toast(err.message, 'error');
    return;
  }
  if (doc !== S.doc) { S.compiling = false; return; } // left the document meanwhile
  S.errors = res.errors || [];
  S.notes = res.notes || [];
  const secs = (res.durationMs / 1000).toFixed(1);
  const cached = res.mode === 'cached preamble';
  const title = `${res.mode || ''}${res.formatRebuilt ? ' — preamble rebuilt' : ''}`;
  if (S.errors.length) setStatus(`✗ ${secs} s`, 'error', title);
  else setStatus(`✓ ${secs} s${res.formatRebuilt ? ' · preamble rebuilt' : cached ? ' · cached' : ''}`, 'ok', title);
  if (res.main) S.main = res.main;
  applyDiagnostics();
  renderProblems();
  renderTree();
  if (res.pdfUpdated || (res.hasPdf && !pdf.data)) {
    try { await pdf.load(api.pdfUrl(doc)); } catch (err) { toast(err.message, 'error'); }
  }
  S.compiling = false;
  refreshGit();
  if (S.pending || anyDirty()) { S.pending = false; if (!S.timer) flush(); }
}

// ---------------------------------------------------------------- errors

function applyDiagnostics() {
  const doc = view.state.doc;
  const diags = S.errors
    .filter((e) => e.file === S.current && e.line)
    .map((e) => {
      const l = doc.line(Math.max(1, Math.min(e.line, doc.lines)));
      return { from: l.from, to: l.to, severity: 'error', message: e.message };
    });
  view.dispatch(setDiagnostics(view.state, diags));
}

let problemsClosed = false; // closed by hand from the status bar
function renderProblems() {
  el.sbErrors.textContent = S.errors.length;
  el.sbNotes.textContent = S.notes.length;
  $('sb-problems').classList.toggle('has-errors', S.errors.length > 0);
  $('sb-problems').hidden = S.errors.length === 0 && S.notes.length === 0;
  el.problems.textContent = '';
  const empty = S.errors.length === 0 && S.notes.length === 0;
  if (empty) problemsClosed = false;
  el.problems.hidden = empty || problemsClosed;
  for (const n of S.notes) {
    const row = document.createElement('div');
    row.className = 'problem note';
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = 'note';
    const msg = document.createElement('span');
    msg.textContent = n;
    row.append(where, msg);
    el.problems.appendChild(row);
  }
  for (const e of S.errors) {
    const row = document.createElement('div');
    row.className = 'problem';
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = e.file ? `${e.file}:${e.line}` : 'log';
    const msg = document.createElement('span');
    msg.textContent = e.message;
    row.append(where, msg);
    if (e.file && S.files.some((f) => f.path === e.file && f.editable)) {
      row.classList.add('link');
      row.addEventListener('click', () => openFile(e.file, e.line));
    }
    el.problems.appendChild(row);
  }
}
$('sb-problems').addEventListener('click', () => {
  if (!S.errors.length && !S.notes.length) return;
  problemsClosed = !el.problems.hidden;
  el.problems.hidden = problemsClosed;
});

// ---------------------------------------------------------------- versioning: status, commit, history

async function refreshGit() {
  if (!S.doc) return;
  try {
    const { commits, status } = await api.log(S.doc);
    S.commits = commits;
    S.changes = status.files || [];
    const n = S.changes.length;
    el.changesCount.textContent = n ? `(${n})` : '';
    el.sbChanges.textContent = n ? ` ${n}` : ' ✓';
    $('sb-changes').title = n ? `${n} uncommitted change(s)` : (status.last ? `Last commit: ${status.last}` : 'No commit yet');
    renderChanges();
    renderHistory();
    renderTree();
  } catch { /* not critical */ }
}

function openVersioning(focusMessage) {
  setLeftTab('versioning');
  if (focusMessage) el.commitMsg.focus();
}
// The branch icon in the status bar opens / closes the versioning pane.
$('sb-changes').addEventListener('click', () => {
  if (S.leftTab === 'versioning' && S.showTree) setLeftTab('files');
  else openVersioning(true);
});

async function commit(message) {
  try {
    await flush();
    const r = await api.commit(S.doc, message);
    toast(r.nothing ? 'Nothing to commit' : `Committed ${r.hash}`, 'ok');
    el.commitMsg.value = '';
  } catch (err) {
    toast(`Commit failed — ${err.message}`, 'error');
  }
  refreshGit();
}

function commitFromBox() {
  const msg = el.commitMsg.value.trim();
  if (!msg) { el.commitMsg.focus(); toast('Write a message first.'); return; }
  commit(msg);
}
el.commitBtn.addEventListener('click', commitFromBox);
el.commitMsg.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commitFromBox(); }
  if (e.key === 'Escape') view.focus();
});

function setLeftTab(tab) {
  S.leftTab = tab;
  if (!S.showTree) toggleTree();
  $('sb-changes').classList.toggle('active', tab === 'versioning');
  el.filesPane.hidden = tab !== 'files';
  el.scmPane.hidden = tab !== 'versioning';
  S.creating = null;
  if (tab === 'versioning') refreshGit();
}
$('scm-close').addEventListener('click', () => { setLeftTab('files'); view.focus(); });

function renderChanges() {
  el.changesList.textContent = '';
  if (!S.changes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing to commit.';
    el.changesList.appendChild(li);
    return;
  }
  for (const c of S.changes) {
    const li = document.createElement('li');
    li.className = 'change';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = c.path;
    const code = document.createElement('span');
    code.className = `vcs vcs-${c.code}`;
    code.textContent = c.code;
    li.append(name, code);
    const editable = S.files.some((f) => f.path === c.path && f.editable);
    if (editable) li.addEventListener('click', () => openFile(c.path));
    else li.classList.add('muted');
    el.changesList.appendChild(li);
  }
}

function renderHistory() {
  el.history.textContent = '';
  if (!S.commits.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No commit yet.';
    el.history.appendChild(li);
    return;
  }
  for (const c of S.commits) {
    const li = document.createElement('li');
    li.className = 'commit';
    if (S.viewedCommit === c.hash) li.classList.add('current');
    const subject = document.createElement('div');
    subject.className = 'subject';
    subject.textContent = c.subject;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const hash = document.createElement('b');
    hash.textContent = c.short;
    meta.append(hash, ` · ${c.relative}`);
    li.append(subject, meta);
    li.title = new Date(c.date).toLocaleString();
    li.addEventListener('click', () => showCommit(c));
    el.history.appendChild(li);
  }
}

async function showCommit(c) {
  try {
    const { patch } = await api.show(S.doc, c.hash);
    S.viewedCommit = c.hash;
    el.commitTitle.textContent = `${c.short} · ${c.subject}`;
    el.commitPatch.textContent = '';
    for (const line of patch.split('\n')) {
      const span = document.createElement('span');
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) span.className = 'file';
      else if (line.startsWith('+')) span.className = 'add';
      else if (line.startsWith('-')) span.className = 'del';
      else if (line.startsWith('@@')) span.className = 'hunk';
      span.textContent = `${line}\n`;
      el.commitPatch.appendChild(span);
    }
    el.commitView.hidden = false;
    el.commitPatch.scrollTop = 0;
    renderHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function closeCommitView() {
  if (el.commitView.hidden) return;
  el.commitView.hidden = true;
  S.viewedCommit = null;
  renderHistory();
}
$('commit-close').addEventListener('click', () => { closeCommitView(); view.focus(); });

$('restore-btn').addEventListener('click', async () => {
  const c = S.commits.find((x) => x.hash === S.viewedCommit);
  if (!c) return;
  await flush();
  let force = false;
  if (S.changes.length) {
    force = window.confirm(`You have ${S.changes.length} uncommitted change(s). Restoring "${c.subject}" will overwrite them.\n\nContinue?`);
    if (!force) return;
  }
  try {
    await api.restore(S.doc, c.hash, force);
  } catch (err) {
    toast(`Restore failed — ${err.message}`, 'error');
    return;
  }
  toast(`Files restored to ${c.short}. Commit to keep this version.`, 'ok');
  closeCommitView();
  // reload everything from disk
  const current = S.current;
  S.buffers.clear();
  S.current = null;
  await refreshTree();
  const still = S.files.some((f) => f.path === current && f.editable);
  await openFile(still ? current : (S.main || (S.files.find((f) => f.editable) || {}).path));
  compile();
});

// ---------------------------------------------------------------- settings: delay, zoom, columns

el.delay.value = S.delay;
el.delay.addEventListener('change', () => {
  const v = Math.round(Number(el.delay.value));
  S.delay = Number.isFinite(v) ? Math.min(5000, Math.max(200, v)) : 800;
  el.delay.value = S.delay;
  prefs.set('delay', S.delay);
});

$('zoom-in').addEventListener('click', () => pdf.setZoom(pdf.zoom * 1.2));
$('zoom-out').addEventListener('click', () => pdf.setZoom(pdf.zoom / 1.2));
function setPdfMode(mode) {
  pdf.setMode(mode);
  applyWidths();
  prefs.set('pdfMode', mode);
  markPdfMode();
}
// one button: "page" (the whole page, the column sized to it) or "width" (the page as wide as the column)
function markPdfMode() { $('zoom-mode').textContent = pdf.mode === 'page' ? 'page' : 'width'; }
$('zoom-mode').addEventListener('click', () => setPdfMode(pdf.mode === 'page' ? 'width' : 'page'));
markPdfMode();

const widths = prefs.get('widths', { tree: 240, pdf: 0 });
// In "page" mode the preview column hugs the page: its width follows the
// available height, and the editor gets the rest. In "width" mode it keeps the
// width set by dragging the gutter.
function applyWidths() {
  el.editorView.style.setProperty('--tree-w', `${widths.tree}px`);
  let pdfW = widths.pdf ? `${widths.pdf}px` : '1fr';
  if (pdf.mode === 'page' && pdf.aspect) {
    const rect = el.cols.getBoundingClientRect();
    const pdfArea = $('pdf');
    const inner = pdfArea.clientHeight || (rect.height - 40);
    const border = document.documentElement.dataset.theme === 'thudal' ? 0 : 2; // panel borders
    const want = Math.round(inner * pdf.aspect + border);
    const treeW = S.showTree ? widths.tree + 6 : 0;
    const max = rect.width - treeW - 12 - 6 - 300; // keep at least 300px for the editor
    pdfW = `${Math.max(240, Math.min(want, max))}px`;
  }
  el.editorView.style.setProperty('--pdf-w', pdfW);
}
window.addEventListener('resize', () => applyWidths());
applyWidths();
for (const g of document.querySelectorAll('.gutter')) {
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => {
      const rect = el.cols.getBoundingClientRect();
      const treeW = S.showTree ? widths.tree : 0;
      if (g.dataset.resize === 'tree') widths.tree = Math.max(160, Math.min(480, ev.clientX - rect.left));
      else {
        if (pdf.mode === 'page') setPdfMode('width'); // dragging = choosing the width by hand
        widths.pdf = Math.max(240, Math.min(rect.width - treeW - 260, rect.right - ev.clientX));
      }
      applyWidths();
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      prefs.set('widths', widths);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  });
}

window.addEventListener('beforeunload', (e) => {
  if (anyDirty() || S.timer) { flush(); e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- documents

async function refreshTree() {
  const t = await api.tree(S.doc);
  S.files = t.files;
  S.main = t.main;
  renderTree();
}

async function leaveDoc() {
  if (anyDirty() || S.timer) await flush();
  S.doc = null;
  S.buffers.clear();
  S.current = null;
  S.errors = [];
  S.notes = [];
  S.commits = [];
  S.changes = [];
  closeCommitView();
}

async function loadDoc(doc, wantedFile) {
  S.doc = doc;
  S.buffers.clear();
  S.current = null;
  S.errors = [];
  S.notes = [];
  S.creating = null;
  S.selected = null;
  pdf.clear();
  showScreen('editor');
  el.docName.textContent = doc;
  document.title = `${doc} · latex.thudal`;
  setStatus('', '');
  renderProblems();
  try {
    await refreshTree();
  } catch (err) {
    toast(`Cannot open ${doc}: ${err.message}`, 'error');
    location.hash = '';
    return;
  }
  setLeftTab(S.leftTab);
  const exists = (p) => S.files.some((f) => f.path === p && f.editable);
  const first = (wantedFile && exists(wantedFile) && wantedFile) || (S.main && exists(S.main) && S.main)
    || (S.files.find((f) => f.editable) || {}).path;
  if (first) await openFile(first);
  applyWidths();
  pdf.load(api.pdfUrl(doc)).catch(() => {}); // show the last PDF right away, if any
  refreshGit();
  compile();
}

route();
