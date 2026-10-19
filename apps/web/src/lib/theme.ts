/** The technician's theme choice; `system` follows the operating system. */
export type ThemePreference = 'system' | 'light' | 'dark';

const storageKey = 'open-itsm-theme';

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The `data-theme` value for <html>; `undefined` lets the stylesheet follow the OS. */
export function themeAttribute(preference: ThemePreference): 'light' | 'dark' | undefined {
  return preference === 'system' ? undefined : preference;
}

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(storageKey));
  } catch {
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference) {
  const attribute = themeAttribute(preference);
  if (attribute) document.documentElement.dataset.theme = attribute;
  else delete document.documentElement.dataset.theme;
}

export function saveThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
  applyThemePreference(preference);
}
