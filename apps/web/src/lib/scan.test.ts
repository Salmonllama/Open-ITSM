import { describe, expect, it } from 'vitest';
import { parseScan, tagUrl } from './scan';

describe('tag URLs', () => {
  it('puts the asset number after /a/', () => {
    expect(tagUrl('https://itsm.example.com', 'LAP-000123')).toBe(
      'https://itsm.example.com/a/LAP-000123',
    );
  });

  it('round-trips numbers with slashes and dots', () => {
    for (const number of ['OLD/42', 'srv.01', 'LAP-000123']) {
      const url = tagUrl('https://itsm.example.com', number);
      expect(parseScan(url)).toBe(number);
    }
    expect(tagUrl('https://x', 'OLD/42')).toBe('https://x/a/OLD%2F42');
  });
});

describe('parseScan', () => {
  it('reads a tag URL from any host', () => {
    expect(parseScan('https://other.example.org/a/LAP-000001')).toBe('LAP-000001');
    expect(parseScan('http://localhost:5173/a/LAP-000001')).toBe('LAP-000001');
  });

  it('accepts a typed number with surrounding whitespace, as scanners add a newline', () => {
    expect(parseScan('  lap-000001\n')).toBe('lap-000001');
  });

  it('refuses other URLs and text that cannot be an asset number', () => {
    expect(parseScan('https://example.com/')).toBeNull();
    expect(parseScan('https://example.com/assets/123')).toBeNull();
    expect(parseScan('https://example.com/a/%E0%A4%A')).toBeNull();
    expect(parseScan('hello world')).toBeNull();
    expect(parseScan('')).toBeNull();
  });
});
