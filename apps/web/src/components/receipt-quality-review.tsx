import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const MAX_BYTES = 10 * 1024 * 1024;
type Crop = { x: number; y: number; width: number; height: number };
type Warning = 'blur' | 'dark' | 'small';

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

function warningsFor(image: HTMLImageElement): Warning[] {
  const canvas = document.createElement('canvas');
  const side = 80;
  canvas.width = side; canvas.height = side;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, side, side);
  const pixels = context.getImageData(0, 0, side, side).data;
  let luminance = 0; let edges = 0;
  for (let y = 1; y < side; y += 1) for (let x = 1; x < side; x += 1) {
    const at = (y * side + x) * 4; const previous = (y * side + x - 1) * 4;
    const value = 0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!;
    const left = 0.2126 * pixels[previous]! + 0.7152 * pixels[previous + 1]! + 0.0722 * pixels[previous + 2]!;
    luminance += value; edges += Math.abs(value - left);
  }
  const count = (side - 1) * (side - 1);
  return [
    ...(image.naturalWidth < 1000 || image.naturalHeight < 1000 ? ['small' as const] : []),
    ...(luminance / count < 55 ? ['dark' as const] : []),
    ...(edges / count < 7 ? ['blur' as const] : []),
  ];
}

async function jpegFrom(image: HTMLImageElement, crop: Crop, rotation: number): Promise<File> {
  const sourceWidth = image.naturalWidth; const sourceHeight = image.naturalHeight;
  const width = Math.max(1, Math.round(sourceWidth * crop.width));
  const height = Math.max(1, Math.round(sourceHeight * crop.height));
  const turns = (rotation / 90) % 4; const canvas = document.createElement('canvas');
  canvas.width = turns % 2 ? height : width; canvas.height = turns % 2 ? width : height;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Photo editing is unavailable in this browser.');
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate((rotation * Math.PI) / 180);
  context.drawImage(image, Math.round(sourceWidth * crop.x), Math.round(sourceHeight * crop.y), width, height, -width / 2, -height / 2, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not create the edited photo.');
  return new File([blob], 'receipt.jpg', { type: 'image/jpeg' });
}

export function ReceiptQualityReview({ file, onUse, onRetake }: { file: File | undefined; onUse: (file: File) => void; onRetake: () => void }) {
  if (!file) return null;
  return <Review file={file} key={`${file.name}:${file.size}:${file.lastModified}`} onUse={onUse} onRetake={onRetake} />;
}

function Review({ file, onUse, onRetake }: { file: File; onUse: (file: File) => void; onRetake: () => void }) {
  const image = useRef<HTMLImageElement | null>(null); const drag = useRef<{ x: number; y: number } | null>(null);
  const [preview] = useState(() => URL.createObjectURL(file)); const [available, setAvailable] = useState(false); const [warnings, setWarnings] = useState<Warning[]>([]);
  const [editing, setEditing] = useState(false); const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, width: 1, height: 1 }); const [rotation, setRotation] = useState(0); const [error, setError] = useState<string>();
  useEffect(() => () => URL.revokeObjectURL(preview), [preview]);
  const edited = crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1 || rotation !== 0;
  const warningText: Record<Warning, string> = { blur: 'This image may be blurry.', dark: 'This image may be too dark to read clearly.', small: 'This image may be too small to read clearly.' };
  async function apply() { if (!image.current) return; try { setError(undefined); const next = await jpegFrom(image.current, crop, rotation); if (next.size > MAX_BYTES) { setError('The edited photo is larger than 10 MB. Crop further, reset, or retake it.'); return; } onUse(next); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create the edited photo.'); } }
  function selection(event: React.PointerEvent<HTMLDivElement>) { const rect = event.currentTarget.getBoundingClientRect(); return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) }; }
  return <Dialog open onOpenChange={(open) => { if (!open) onRetake(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{editing ? 'Edit photo' : 'Check receipt photo'}</DialogTitle><DialogDescription>{editing ? 'Drag across the image to choose a crop. Rotate is clockwise.' : 'Check the photo before it is uploaded and read.'}</DialogDescription></DialogHeader>
    {!available ? <><img className="max-h-72 w-full object-contain" src={preview} alt="Selected receipt" onLoad={(event) => { image.current = event.currentTarget; setAvailable(true); setWarnings(warningsFor(event.currentTarget)); }} onError={() => setAvailable(false)} />{file.type.includes('heic') || file.type.includes('heif') ? <p className="text-sm text-muted-foreground">This format can be uploaded, but preview and editing are unavailable on this device.</p> : <p className="text-sm text-muted-foreground">Preparing preview…</p>}</> : editing ? <div className="relative touch-none overflow-hidden rounded-lg bg-muted" onPointerDown={(event) => { drag.current = selection(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; const end = selection(event); const start = drag.current; setCrop({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }); }} onPointerUp={() => { drag.current = null; }}><img className="max-h-80 w-full object-contain" src={preview} alt="Crop receipt" style={{ transform: `rotate(${rotation}deg)` }} /><div className="pointer-events-none absolute border-2 border-primary" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} /></div> : <><img className="max-h-72 w-full object-contain" src={preview} alt="Selected receipt" />{warnings.map((warning) => <Alert key={warning} variant="destructive"><AlertDescription>{warningText[warning]}</AlertDescription></Alert>)}</>}
    {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
    <DialogFooter>{editing ? <><Button type="button" variant="outline" onClick={() => { setCrop({ x: 0, y: 0, width: 1, height: 1 }); setRotation(0); }}>Reset</Button><Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button><Button type="button" onClick={() => setEditing(false)} disabled={crop.width < 0.05 || crop.height < 0.05}>Apply edits</Button><Button type="button" variant="outline" onClick={() => setRotation((value) => (value + 90) % 360)}>Rotate 90°</Button></> : <><Button type="button" variant="outline" onClick={onRetake}>Retake</Button>{available && <Button type="button" variant="outline" onClick={() => setEditing(true)}>Edit photo</Button>}<Button type="button" onClick={() => edited ? void apply() : onUse(file)}>{warnings.length ? 'Use anyway' : 'Use photo'}</Button></>}</DialogFooter>
  </DialogContent></Dialog>;
}
