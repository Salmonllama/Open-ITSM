import { useEffect, useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input, Label } from './ui/input';

/** Searches as you type, after a short pause, so each keystroke does not hit the server. */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  // Follow the address when it changes from elsewhere, such as the back button.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>Search</Label>
      <Input
        id={id}
        type="search"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
