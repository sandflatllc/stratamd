import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** Generated locally. Pairing credentials never leave this renderer for QR generation. */
export function PairingQr({ value }: { value: string }) {
  const image = useMemo(() => {
    try { const code = qrcode(0, 'M'); code.addData(value); code.make(); return code.createDataURL(4, 16) }
    catch { return null }
  }, [value])
  return image ? <img className="pairing-qr" src={image} alt="Scan this code with the other device to pair" /> : <p>Use Copy pairing link to connect your other device.</p>
}
