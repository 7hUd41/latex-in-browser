# latex-in-browser

A self-hosted LaTeX editor that runs in the browser and compiles on your own
server. Made for one person and a handful of documents (a CV, letters, notes),
with the comfort of vim and a live preview.

```
┌──────────┬────────────────────────┬────────────────────────┐
│ files    │ CodeMirror (vim keys)  │ PDF preview (pdf.js)   │
│          │                        │                        │
├──────────┼────────────────────────┼────────────────────────┤
│ ⚙ ▯ ⎇ 2  │ NORMAL                 │ ✓ 0.9 s   − page +   ⤓ │
└──────────┴────────────────────────┴────────────────────────┘
```

It runs on latex.thudal.com. A public demo is coming.

## What it does

- **Compile on pause.** Every pause in typing (800 ms by default) saves the
  changed files and recompiles; the preview follows, without flicker and without
  losing its scroll position. `:w` (or Cmd/Ctrl-S) does it at once.
- **Fast.** One `xelatex` run plus `xdvipdfmx` (latexmk only for documents with a
  `.bib`), and a **preamble cache**: the class and packages are precompiled once,
  so a two-page CV compiles in about a second.
- **Vim keys** (CodeMirror 6 with `@replit/codemirror-vim`), LaTeX highlighting,
  errors shown at their file and line.
- **SyncTeX**: Cmd/Ctrl-Enter or `:sync` shows the cursor's line in the PDF;
  double-click the PDF to jump to the code.
- **Files**: a tree with new file / new folder, Cmd/Ctrl-click (or `gf`) on
  `\input{…}` to open that file. The main file is in bold, unsaved files have a ●.
- **Versioning**: each document is a git repository. Commit by hand (message box,
  or `:commit message`), see the changes and the history as a graph, open any
  commit to see its diff and **restore** it (history is never rewritten).
- **Projects**: a project list; new projects start empty or as a copy of another
  one. Click the project name to rename it.
- **PDF**: zoom with − + or by pinching, **page** (the whole page, the column sized
  to it) or **width**, download.
- **Themes**: *code* (VS Code-like, Ayu colours) and *thudal* (square, the colours
  of thudal.com), each light or dark. In dark mode the preview takes the theme's
  paper and ink; the downloaded PDF keeps its normal colours.
- **Status bar** split under the three columns: settings, sidebar and versioning
  under the files; vim mode, messages and errors under the editor; compile time,
  zoom and download under the PDF.

Font: Fira Code with ligatures, everywhere.

## Security

Compiling LaTeX means running code on the server. So:

- a login page (one user, scrypt password hash, signed cookie, 5 wrong attempts
  from one address lock it for 15 minutes);
- every write request also needs an `X-Editor` header (blocks cross-site requests);
- no shell escape, no reading or writing outside the document (`openin_any=p`,
  `openout_any=p`), `latexmk -norc`;
- each compilation runs in **bubblewrap**: no network, read-only system, only the
  document folder writable, `.git` read-only, killed after 60 s;
- git hooks are disabled for every git command the server runs;
- the service itself is locked down by systemd (`deploy/latex-editor.service`);
- paths from the browser are validated: no `..`, no hidden files, no `build/`.

## Install (Debian 13)

What you need: a Linux server with Node.js 20 or later, TeX Live, bubblewrap, git,
and a reverse proxy for HTTPS (the examples use Caddy).

1. Packages. Add the TeX Live packages your documents need; this is a minimal
   XeLaTeX set:

   ```sh
   sudo apt install --no-install-recommends nodejs git bubblewrap fontconfig \
     texlive-xetex latexmk texlive-latex-recommended texlive-latex-extra lmodern
   ```

2. A user for the service, and the documents folder:

   ```sh
   sudo useradd --system --home-dir /var/lib/latex --shell /usr/sbin/nologin latex
   sudo mkdir -p /var/lib/latex/docs
   sudo chown -R latex:latex /var/lib/latex
   ```

3. The code, owned by root (the service can only read it):

   ```sh
   sudo git clone https://github.com/7hUd41/latex-in-browser.git /opt/latex-editor
   ```

4. The login. `hash-password.js` asks for the password twice and prints the
   settings; install them readable only by the service:

   ```sh
   node /opt/latex-editor/server/hash-password.js yourname > latex-auth.env
   sudo install -o root -g latex -m 640 latex-auth.env /etc/latex-editor.env
   rm latex-auth.env
   ```

5. The service. Edit `GIT_NAME` and `GIT_EMAIL` in the unit first (the author of
   your commits):

   ```sh
   sudo cp /opt/latex-editor/deploy/latex-editor.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now latex-editor
   ```

   It listens on `127.0.0.1:8090` only.

6. HTTPS: add `deploy/Caddyfile-block` (with your domain) to your Caddyfile and
   reload Caddy.

Logs: `sudo journalctl -u latex-editor -f`. Include `/var/lib/latex/docs` in your
backups.

### Settings

Environment variables of the service:

| Variable | Default | What |
|---|---|---|
| `PORT` | `8090` | Port (on 127.0.0.1) |
| `DOCS_DIR` | `/var/lib/latex/docs` | One folder per document |
| `COMPILE_TIMEOUT_MS` | `60000` | A compilation is killed after this |
| `GIT_NAME`, `GIT_EMAIL` | | Author of the commits |
| `AUTH_USER`, `AUTH_HASH`, `SESSION_SECRET` | | Made by `server/hash-password.js` |
| `SESSION_DAYS` | `30` | How long a login lasts |

For local development only: `AUTH=off`, `SANDBOX=off`, `COOKIE_SECURE=off`.

## Documents

The main file of a document is `main.tex` if present, otherwise the first `.tex`
file at the root that contains `\documentclass`. Output goes to `build/` inside
the document.

### The preamble cache

Put this line in the main file, after the class and packages and **before any font
loading** (fontspec, or a package that loads OpenType fonts):

```latex
\csname endofdump\endcsname
```

Everything above it is precompiled once into `build/preamble.fmt`
(mylatexformat) and rebuilt automatically when that part, or a file it `\input`s,
changes. Outside the editor the line does nothing.

### Adding LaTeX packages

The editor cannot install anything, on purpose. On the server, check with
`kpsewhich name.sty` and install from Debian (`sudo apt install texlive-…`), or drop
the `.sty` or font file into the document folder.

## Layout of the code

| Path | What |
|---|---|
| `server/server.js` | Backend. Node standard library only, no npm dependency. |
| `server/hash-password.js` | Makes the login settings. |
| `public/` | What the browser loads. `app.js` and `pdf.worker.min.mjs` are built files, committed so the server needs no build step. |
| `src/` | Front-end sources, bundled into `public/app.js`. |
| `deploy/` | systemd unit and Caddy block. |

To change the front-end:

```sh
npm install      # dev tools only: esbuild, CodeMirror, pdf.js
npm run build    # rebuilds public/app.js and public/pdf.worker.min.mjs
```

Colours and layout are in `public/style.css`; the editor's theme in `src/editor.js`.

## Licence

MIT, see `LICENSE`. The bundled libraries and the font keep their own licences,
see `THIRD-PARTY-NOTICES.md` and `public/fonts/OFL.txt`.
