import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

interface MarkdownProps {
  content: string;
  /** Render inverted-on-primary styles for user bubbles. */
  inverted?: boolean;
}

/** Compact markdown renderer tuned for chat bubbles: GFM tables /
 *  checklists / strikethrough enabled, links open in a new tab, fenced
 *  code blocks get syntax highlighting (highlight.js tokens, themed in
 *  index.css) plus a copy button. */
export function Markdown({ content, inverted }: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose-chat min-w-0",
        inverted && "prose-chat-inverted",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          // Wrap tables in a horizontally-scrollable container so wide
          // schema dumps don't force columns to wrap into vertical
          // ribbons inside the narrow chat bubble.
          table: ({ node: _node, children, ...props }) => (
            <div className="not-prose -mx-1 my-1 overflow-x-auto">
              <table {...props}>{children}</table>
            </div>
          ),
          pre: ({ node: _node, children, ...props }) => (
            <CodeBlock inverted={inverted} {...props}>
              {children}
            </CodeBlock>
          ),
          code: ({ node: _node, className, children, ...props }) => {
            const isBlock = (className ?? "").includes("language-");
            if (isBlock) {
              // Inside <pre>: keep hljs classes for the syntax theme.
              return (
                <code className={cn(className, "hljs block")} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={cn(
                  "rounded-sm px-1 py-0.5 font-mono text-[0.85em]",
                  inverted
                    ? "bg-primary-foreground/15 text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface CodeBlockProps {
  children?: ReactNode;
  inverted?: boolean;
}

function CodeBlock({ children, inverted }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { language, text } = extractCode(children);

  const onCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in some webviews; silently skip.
    }
  };

  return (
    <div
      className={cn(
        "group relative my-1 overflow-hidden rounded-md border",
        inverted
          ? "border-primary-foreground/20 bg-primary-foreground/10"
          : "border-border bg-muted/60",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b px-2.5 py-1 text-[10.5px] font-medium uppercase tracking-wide",
          inverted
            ? "border-primary-foreground/20 text-primary-foreground/70"
            : "border-border text-muted-foreground",
        )}
      >
        <span>{language || "code"}</span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? "Copiado" : "Copiar código"}
          title={copied ? "Copiado" : "Copiar"}
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] normal-case opacity-70 transition hover:opacity-100",
            inverted
              ? "hover:bg-primary-foreground/15"
              : "hover:bg-accent hover:text-foreground",
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto rounded-none border-0 bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

/** Pull the language tag and raw text out of the rehype-highlight tree
 *  that react-markdown hands to <pre>. */
function extractCode(children: ReactNode): { language: string; text: string } {
  let language = "";
  let text = "";
  const visit = (node: ReactNode) => {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === "string" || typeof node === "number") {
      text += String(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === "object" && "props" in node) {
      const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
      if (props?.className && !language) {
        const m = /language-([\w-]+)/.exec(props.className);
        if (m) language = m[1];
      }
      visit(props?.children);
    }
  };
  visit(children);
  return { language, text: text.replace(/\n$/, "") };
}
