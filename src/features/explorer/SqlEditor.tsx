import CodeMirror from "@uiw/react-codemirror";
import { PostgreSQL, sql } from "@codemirror/lang-sql";

import { useTheme } from "@/components/theme-provider";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Triggered by Cmd/Ctrl+Enter. */
  onRun: () => void;
}

/** A syntax-highlighted SQL editor (CodeMirror) for free-form queries. */
export function SqlEditor({ value, onChange, onRun }: SqlEditorProps) {
  const { resolvedTheme } = useTheme();

  return (
    <div
      className="h-full overflow-hidden text-sm"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          onRun();
        }
      }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={resolvedTheme}
        height="100%"
        style={{ height: "100%" }}
        extensions={[sql({ dialect: PostgreSQL, upperCaseKeywords: true })]}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          autocompletion: true,
          foldGutter: false,
        }}
        placeholder="SELECT * FROM ..."
      />
    </div>
  );
}
