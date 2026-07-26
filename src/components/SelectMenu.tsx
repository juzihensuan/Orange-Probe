import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export default function SelectMenu<T extends string>({ value, options, onChange, label }: { value: T; options: Array<SelectOption<T>>; onChange: (value: T) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const selected = options.find((option) => option.value === value) || options[0];
  return (
    <div className={`manage-select${open ? " open" : ""}`} ref={root}>
      <button type="button" className="manage-select-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        <span>{selected?.label || "--"}</span><ChevronDown size={15} />
      </button>
      {open && <div className="manage-select-menu" role="listbox" aria-label={label}>{options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <Check size={14} />}</button>)}</div>}
    </div>
  );
}
