export const LABEL_LAYOUTS = ['roll', 'letter', 'a4'] as const;
export type LabelLayout = (typeof LABEL_LAYOUTS)[number];

export const labelLayouts: Record<
  LabelLayout,
  { label: string; perSheet: number | null; pageSize: string; hint: string }
> = {
  roll: {
    label: 'Label printer, 2 × 0.75 in',
    perSheet: null,
    pageSize: '2in 0.75in',
    hint: 'Set the label printer to 2 × 0.75 in labels, then print at 100% scale with no margins.',
  },
  letter: {
    label: 'Letter sheet, 30 labels (Avery 5160)',
    perSheet: 30,
    pageSize: 'letter',
    hint: 'Print at 100% scale (Actual size) with no margins on 2⅝ × 1 in label sheets.',
  },
  a4: {
    label: 'A4 sheet, 21 labels (Avery L7160)',
    perSheet: 21,
    pageSize: 'A4',
    hint: 'Print at 100% scale (Actual size) with no margins on 63.5 × 38.1 mm label sheets.',
  },
};

/** Splits tags into printed pages: one per tag on a roll, or full sheets. */
export function toPages<T>(items: T[], layout: LabelLayout): T[][] {
  const size = labelLayouts[layout].perSheet ?? 1;
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

const LAYOUT_KEY = 'open-itsm-label-layout';

/** The layout this browser printed with last, so a team with one printer picks it once. */
export function storedLabelLayout(): LabelLayout {
  try {
    const value = localStorage.getItem(LAYOUT_KEY);
    return LABEL_LAYOUTS.find((l) => l === value) ?? 'roll';
  } catch {
    return 'roll';
  }
}

export function storeLabelLayout(layout: LabelLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Storage can be blocked; the choice just is not remembered.
  }
}
