import { useEffect, useRef, type MutableRefObject } from "react";
import { EditorState } from "@codemirror/state";
import {
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

export type EditorApi = { getValue: () => string };

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
  ".cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
  },
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

export default function SourceEditor({
  initialDoc,
  onDirty,
  onSave,
  apiRef,
}: {
  initialDoc: string;
  onDirty: () => void;
  onSave: () => void;
  apiRef: MutableRefObject<EditorApi | null>;
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
          history(),
          EditorView.lineWrapping,
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
    apiRef.current = { getValue: () => view.state.doc.toString() };
    view.focus();
    return () => {
      view.destroy();
      apiRef.current = null;
    };
    // Mount once per document (main.tsx remounts via `key`); initialDoc is fixed for that edit session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="cm-host" ref={host} />;
}
