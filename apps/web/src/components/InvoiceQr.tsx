import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code for a Lightning invoice, readable by any wallet app. */
/** `disabled` locks the buttons while a payment is in progress, so the same invoice can't be paid twice. */
export function InvoiceQr({ invoice, disabled = false }: { invoice: string; disabled?: boolean }) {
  const [src, setSrc] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    // Upper case is encoded far more compactly in a QR code, and wallets accept it.
    QRCode.toDataURL(`lightning:${invoice}`.toUpperCase(), { margin: 1, width: 256, errorCorrectionLevel: 'L' })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(undefined); });
    return () => { alive = false; };
  }, [invoice]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable: the invoice is shown below to copy by hand */ }
  };

  return (
    <div className="qr">
      {src && <img src={src} alt="Lightning invoice QR code" width={192} height={192} />}
      <div className="qr-actions">
        <a className="button secondary" href={`lightning:${invoice}`} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} onClick={(e) => { if (disabled) e.preventDefault(); }} style={disabled ? { opacity: .45, pointerEvents: 'none' } : undefined}>Open in a wallet app</a>
        <button type="button" className="secondary" disabled={disabled} onClick={copy}>{copied ? 'Copied' : 'Copy invoice'}</button>
      </div>
    </div>
  );
}
