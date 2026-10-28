import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code for any text. */
export function QrImage({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(text, { margin: 1, width: 224, errorCorrectionLevel: 'M' })
      .then((url) => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setSrc(undefined); });
    return () => { alive = false; };
  }, [text]);
  return src ? <img src={src} alt={label} width={176} height={176} style={{ border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} /> : null;
}
