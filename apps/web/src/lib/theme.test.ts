import { describe, expect, it } from 'vitest';
import { parseThemePreference, themeAttribute } from './theme';

describe('theme preference', () => {
  it('falls back to following the OS for missing or unknown values', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('purple')).toBe('system');
    expect(parseThemePreference('dark')).toBe('dark');
  });

  it('sets data-theme only when the user overrides the OS', () => {
    expect(themeAttribute('system')).toBeUndefined();
    expect(themeAttribute('light')).toBe('light');
    expect(themeAttribute('dark')).toBe('dark');
  });
});
