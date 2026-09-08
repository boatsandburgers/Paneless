import { useEffect, useRef, useState } from "react";
import { command, native } from "./types";
import {
  claudeCommand,
  handoffPrompt,
  type Handoff,
  type HandoffContext,
} from "./handoff";
import "./handoff.css";

export default function AgentHandoff({
  snapshot,
  onClose,
}: {
  snapshot: Handoff;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [instruction, setInstruction] = useState("");
  const [context, setContext] = useState<HandoffContext>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const windows = /Win/.test(navigator.platform);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let disposed = false;
    void command<HandoffContext>("handoff_context", { id: snapshot.info.id })
      .then((c) => {
        if (!disposed) setContext(c);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      previous?.focus();
    };
  }, [snapshot]);
  const act = async (action: "copy" | "codex" | "claude" | "claude-open") => {
    if (pending || !context) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      const fresh = await command<HandoffContext>("handoff_context", {
        id: snapshot.info.id,
      });
      setContext(fresh);
      const prompt = handoffPrompt(snapshot, fresh, instruction);
      const text =
        action === "claude"
          ? claudeCommand(fresh.workspace, prompt, windows)
          : prompt;
      if (native)
        await (
          await import("@tauri-apps/plugin-clipboard-manager")
        ).writeText(text);
      else await navigator.clipboard.writeText(text);
      if (action === "claude-open") {
        const included = await command<boolean>("open_claude", {
          id: snapshot.info.id,
          workspace: fresh.workspace,
          prompt,
        });
        setMessage(
          included
            ? "Opened in Claude Code: a terminal session with the prompt filled in, not sent. Context also copied."
            : "Opened Claude Code in the workspace. The prompt was too long for the link; paste it (it is copied).",
        );
      } else if (action === "codex") {
        const included = await command<boolean>("open_codex", {
          id: snapshot.info.id,
          workspace: fresh.workspace,
          prompt,
        });
        setMessage(
          included
            ? "Opened in Codex for review. Context also copied."
            : "Context copied. Paste it into the new Codex composer.",
        );
      } else
        setMessage(
          action === "claude"
            ? `Command copied. Paste into ${windows ? "PowerShell" : "Terminal"} and run to start Claude Code.`
            : "Copied. Paste into your agent conversation.",
        );
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="handoff-dialog"
      aria-labelledby="handoff-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="handoff-heading">
        <h2 id="handoff-title">Ask an agent</h2>
        <button
          aria-label="Close agent handoff"
          disabled={pending}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="handoff-intro">
        Bring this document into your agent conversation.
      </p>
      <div className="handoff-document">
        <strong>{snapshot.info.name}</strong>
        {snapshot.section && <span> › {snapshot.section}</span>}
        <small title={snapshot.info.path}>{snapshot.info.path}</small>
      </div>
      {snapshot.quote ? (
        <blockquote>{snapshot.quote}</blockquote>
      ) : (
        <p className="handoff-hint">
          Whole document · Select a passage before opening this to include a
          quotation.
        </p>
      )}
      {snapshot.truncated && (
        <p className="handoff-notice">
          Selection shortened to 12,000 characters. The file reference is
          included.
        </p>
      )}
      {context && !context.matchesDisk && (
        <p className="handoff-notice">
          This file has changed or is unavailable. The handoff identifies the
          revision you were reading and asks the agent to verify the current
          file.
        </p>
      )}
      <label className="handoff-instruction">
        What should the agent do? <span className="handoff-optional">optional</span>
        <textarea
          autoFocus
          value={instruction}
          maxLength={8000}
          onChange={(e) => {
            setInstruction(e.target.value);
            setMessage("");
          }}
          placeholder="Explain this decision, check the plan, or suggest a change…"
        />
      </label>
      {context && (
        <details className="handoff-preview">
          <summary>Review included context</summary>
          <p>Workspace: {context.workspace}</p>
          <textarea
            aria-label="Handoff preview"
            readOnly
            value={handoffPrompt(snapshot, context, instruction)}
          />
        </details>
      )}
      <div className="handoff-actions">
        <button
          className="handoff-primary"
          disabled={!context || pending}
          onClick={() => void act("copy")}
        >
          Copy for agent
        </button>
        <button
          disabled={!native || !context || pending}
          onClick={() => void act("codex")}
        >
          Open in Codex
        </button>
        <button
          disabled={!native || !context || pending}
          onClick={() => void act("claude-open")}
        >
          Open in Claude Code
        </button>
        <button
          disabled={!context || pending}
          onClick={() => void act("claude")}
        >
          Copy Claude Code command
        </button>
      </div>
      <p className="handoff-hint">
        Codex opens a draft for review. Claude Code opens a terminal session
        with the prompt filled in; nothing is sent until you press Enter.
      </p>
      <p className="handoff-result" role="status">
        {pending ? "Preparing handoff…" : message}
      </p>
      {error && (
        <p className="handoff-notice" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
