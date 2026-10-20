import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { tagUrl } from '@/lib/scan';

/** A QR code as an SVG path, one unit per module, so it scales to any print size. */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: count, path: d };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={className}
    >
      <path fill="#000000" d={path} />
    </svg>
  );
}

/** The org line on every tag. Fixed for now; a setting for it is in docs/IDEAS.md. */
const TAG_ORG = 'Property of IT';
const TAG_HELP = 'Problem with it? Contact IT and quote this number.';

/**
 * The printed tag from the design system: QR code, asset number in large monospace, type and
 * name, and a line for non-technical staff. 2 × 0.75 in, black on white whatever the theme.
 */
export function AssetTag({
  number,
  typeName,
  name,
  origin = window.location.origin,
}: {
  number: string;
  typeName: string;
  name: string;
  origin?: string;
}) {
  return (
    <div className="asset-tag" data-theme="light">
      <QrCode
        value={tagUrl(origin, number)}
        label={`QR code for ${number}`}
        className="asset-tag-code"
      />
      <div className="asset-tag-text">
        <div className="asset-tag-org">{TAG_ORG}</div>
        <div className="asset-tag-number">{number}</div>
        <div className="asset-tag-type">
          {typeName} · {name}
        </div>
        <div className="asset-tag-help">{TAG_HELP}</div>
      </div>
    </div>
  );
}
