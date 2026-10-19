import { useId, useState } from 'react';
import { readThemePreference, saveThemePreference, type ThemePreference } from '@/lib/theme';
import { Label, Select } from './ui/input';

/** Follow the OS by default; technicians can pick light or dark for this browser. */
export function ThemeSelect() {
  const id = useId();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Theme</Label>
      <Select
        id={id}
        value={theme}
        onChange={(e) => {
          const next = e.target.value as ThemePreference;
          setTheme(next);
          saveThemePreference(next);
        }}
      >
        <option value="system">Match system</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </Select>
    </div>
  );
}
