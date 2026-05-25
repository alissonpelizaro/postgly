import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

interface ComposerProps {
  disabled?: boolean;
  onSubmit: (text: string) => void;
}

/** Multi-line input. Enter sends, Shift+Enter inserts newline. */
export function Composer({ disabled, onSubmit }: ComposerProps) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (text.length === 0 || disabled) return;
    onSubmit(text);
    setValue("");
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 border-t border-border bg-card/40 p-2"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder={t("agentChat.placeholder")}
        disabled={disabled}
        className="min-h-[40px] max-h-40 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Button
        type="submit"
        size="icon"
        disabled={disabled || value.trim().length === 0}
        aria-label={t("agentChat.send")}
        title={t("agentChat.send")}
      >
        <Send className="size-4" />
      </Button>
    </form>
  );
}
