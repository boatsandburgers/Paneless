import { useEffect, useRef, type MutableRefObject } from "react";
import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { findMatches } from "./findText";

export type EditorApi = {
  getValue: () => string;
  // Steps to the next or previous match; `current` is its place in the list, -1 with none.
  find: (query: string, backwards: boolean) => { total: number; current: number };
  count: (query: string) => number;
};

// Find in the source. CodeMirror renders only the lines near the viewport, so the page's
// own find cannot see the rest, and a match it selects takes the focus, after which Enter in the
// find box would replace the word. This searches the whole text and selects without focusing.
function findInView(view: EditorView, query: string, backwards: boolean) {
  const matches = findMatches(view.state.doc.toString(), query);
  if (!matches.length) return { total: 0, current: -1 };
  const { from, to } = view.state.selection.main;
  let current = backwards
    ? matches.length - 1 - [...matches].reverse().findIndex((m) => m.from < from)
    : matches.findIndex((m) => m.from >= to);
  if (current < 0 || current >= matches.length)
    current = backwards ? matches.length - 1 : 0;
  const next = matches[current];
  view.dispatch({
    selection: EditorSelection.single(next.from, next.to),
    scrollIntoView: true,
  });
  return { total: matches.length, current };
}

// Colours resolve to the app's CSS tokens, so light/dark follow the reader theme.
const highlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--hl-title)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700", color: "var(--text)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, color: "var(--hl-string)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "var(--muted)" },
]);

// Chrome mapped to the same tokens the reader uses.
const theme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg)",
    height: "100%",
    fontSize: "15px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "16px 20px", caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  // Selection. The base theme paints it #d7d4f0 in both themes with a
  // selector of five classes, so ours repeats that shape or it never applies.
  // Selected text turns --text (selectedText below): links and code fail 4.5:1 on any tint.
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--accent) 22%, var(--bg))",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--accent) 30%, var(--bg))",
  },
  ".cm-selectedText, .cm-selectedText *": { color: "var(--text)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--muted)",
    border: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
    color: "var(--text)",
  },
});

// Marks the selected text from the editor's own state, not through ::selection: WebKit drops
// the DOM selection when the app chrome is clicked while CodeMirror keeps painting the
// selection layer, and ::selection then stops recolouring the text on that tint.
const selectedMark = Decoration.mark({ class: "cm-selectedText" });
const selectedMarks = (state: EditorState): DecorationSet =>
  Decoration.set(
    state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => selectedMark.range(r.from, r.to)),
  );
const selectedText = StateField.define<DecorationSet>({
  create: selectedMarks,
  update: (marks, tr) =>
    tr.selection || tr.docChanged ? selectedMarks(tr.state) : marks,
  provide: (field) => EditorView.decorations.from(field),
});

export default function SourceEditor({
  initialDoc,
  onDirty,
  onSave,
  apiRef,
  focusOnMount = true,
}: {
  initialDoc: string;
  onDirty: () => void;
  onSave: () => void;
  apiRef: MutableRefObject<EditorApi | null>;
  // False while the find bar is open: the focus stays in its box, or Enter would edit.
  focusOnMount?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Keep the latest callbacks without re-creating the editor.
  const dirtyCb = useRef(onDirty);
  dirtyCb.current = onDirty;
  const saveCb = useRef(onSave);
  saveCb.current = onSave;

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          selectedText,
          history(),
          EditorView.lineWrapping,
          // The accessible name the plain <textarea> carried before CodeMirror replaced it;
          // without it a screen reader announces an unlabelled text box.
          EditorView.contentAttributes.of({ "aria-label": "Markdown source" }),
          markdown(),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveCb.current();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) dirtyCb.current();
          }),
        ],
      }),
      parent: host.current!,
    });
    apiRef.current = {
      getValue: () => view.state.doc.toString(),
      find: (query, backwards) => findInView(view, query, backwards),
      count: (query) => findMatches(view.state.doc.toString(), query).length,
    };
    if (focusOnMount) view.focus();
    return () => {
      view.destroy();
      apiRef.current = null;
    };
    // Mount once per document (main.tsx remounts via `key`); initialDoc is fixed for that edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="cm-host" ref={host} />;
}
