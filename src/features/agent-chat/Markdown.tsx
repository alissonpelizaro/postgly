import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

interface MarkdownProps {
  content: string;
  /** Render inverted-on-primary styles for user bubbles. */
  inverted?: boolean;
}

/** Compact markdown renderer tuned for chat bubbles: GFM tables /
 *  checklists / strikethrough enabled, links open in a new tab, and code
 *  blocks/inline code get monospace styling that matches the rest of
 *  the app. Layout-only — no plugin that touches HTML. */
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
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          code: ({ node: _node, className, children, ...props }) => {
            const isBlock = (className ?? "").includes("language-");
            if (isBlock) {
              return (
                <code className={cn(className, "block")} {...props}>
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
