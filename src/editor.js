// CodeMirror 6 setup: vim mode, LaTeX highlighting, theme.

import { EditorState } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter } from '@codemirror/lint';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags as t } from '@lezer/highlight';
import { vim } from '@replit/codemirror-vim';

export { EditorState, EditorView };

const latex = StreamLanguage.define(stex);

// Colours come from CSS variables (public/style.css), so the light/dark
// switch is instant and the palette lives in one place.
const v = (name) => `var(--${name})`;

const theme = EditorView.theme({
  '&': { height: '100%', color: v('ed-fg'), backgroundColor: v('ed-bg') },
  '.cm-scroller': { fontFamily: 'var(--code)', fontSize: 'var(--editor-size)', lineHeight: 'var(--editor-lh, 1.55)', fontVariantLigatures: 'contextual common-ligatures' },
  '.cm-content': { caretColor: v('ed-cursor'), padding: '10px 0 40vh' },
  '.cm-gutters': { backgroundColor: v('ed-bg'), color: v('ed-gutter'), border: 'none' },
  '.cm-activeLine': { backgroundColor: v('ed-line') },
  '.cm-activeLineGutter': { backgroundColor: v('ed-line'), color: v('ed-gutter-active') },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: `${v('ed-selection')} !important` },
  '.cm-fat-cursor': { background: `${v('ed-cursor')} !important`, color: `${v('ed-bg')} !important` },
  '&:not(.cm-focused) .cm-fat-cursor': { background: 'none !important', outline: `1px solid ${v('ed-cursor')}` },
  '.cm-cursor': { borderLeftColor: v('ed-cursor'), borderLeftWidth: '2px' },
  '.cm-panels': { backgroundColor: v('panel'), color: v('ed-fg') },
  '.cm-panels-bottom': { borderTop: `1px solid ${v('line')}` },
  '.cm-vim-panel': { fontFamily: 'var(--mono)', padding: '2px 8px', minHeight: '1.6em' },
  '.cm-vim-panel input': { color: v('ed-fg'), fontFamily: 'var(--mono)' },
  '.cm-matchingBracket': { backgroundColor: v('ed-match'), outline: 'none' },
  '.cm-searchMatch': { backgroundColor: v('ed-find') },
  '.cm-selectionMatch': { backgroundColor: v('ed-selection-match') },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${v('error')}`, textUnderlineOffset: '3px' },
  '.cm-lint-marker-error': { content: 'none' },
  '.cm-tooltip': { backgroundColor: v('popup'), border: `1px solid ${v('line')}`, color: v('ed-fg') },
  '.cm-diagnostic-error': { borderLeft: `3px solid ${v('error')}` },
});

const highlight = HighlightStyle.define([
  { tag: t.tagName, color: v('syn-command') }, // \commands
  { tag: t.atom, color: v('syn-arg') }, // {itemize}, {graphicx}, numbers
  { tag: t.keyword, color: v('syn-math-delim') }, // $, \[ \]
  { tag: t.special(t.variableName), color: v('syn-math') }, // letters in math
  { tag: t.number, color: v('syn-number') },
  { tag: t.bracket, color: v('syn-bracket') },
  { tag: t.comment, color: v('syn-comment'), fontStyle: 'italic' },
  { tag: t.invalid, color: v('error') },
]);

// Builds the extensions for one file. `onChange` is called on every edit,
// `onSaveKey` on Cmd/Ctrl-S.
export function editorExtensions({ onChange, onSaveKey, onSyncKey, onCursor, onOpenAt }) {
  return [
    vim({ status: false }), // must come first so vim keys win; the mode is shown in the status bar
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    latex,
    syntaxHighlighting(highlight),
    lintGutter(),
    theme,
    keymap.of([
      { key: 'Mod-s', run: () => { onSaveKey(); return true; } },
      { key: 'Mod-Enter', run: () => { onSyncKey(); return true; } },
      ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
    ]),
    // Cmd/Ctrl-click on \input{…}: open that file
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null || !onOpenAt(pos, false)) return false;
        e.preventDefault();
        return true;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u);
      if (u.docChanged || u.selectionSet || u.focusChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        onCursor(line.number, head - line.from + 1);
      }
    }),
  ];
}
