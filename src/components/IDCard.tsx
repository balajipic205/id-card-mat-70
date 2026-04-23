import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import templateImg from "@/assets/id-template.png";
import { LayoutConfig } from "@/lib/idcard-store";
import { resolvePhotoUrl } from "@/lib/supabase";

export interface CardPerson {
  id: string;
  name: string;
  photo: string | null;
}

interface Props {
  person: CardPerson;
  layout: LayoutConfig;
  /** Width of the card in CSS pixels. Height is derived from template aspect ratio. */
  width: number;
  className?: string;
}

// Template natural aspect ratio (h/w). The uploaded template is roughly 884x1044.
export const TEMPLATE_RATIO = 1044 / 884;

export function IDCard({ person, layout, width, className }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const photoUrl = resolvePhotoUrl(person.photo);
  const height = width * TEMPLATE_RATIO;

  useEffect(() => {
    QRCode.toDataURL(person.id, {
      margin: 1,
      width: 400,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(""));
  }, [person.id]);

  return (
    <div
      className={"relative overflow-hidden " + (className ?? "")}
      style={{
        width,
        height,
        backgroundImage: `url(${templateImg})`,
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Photo */}
      <div
        className="absolute overflow-hidden bg-black/20"
        style={{
          left: `${layout.photo.x - layout.photo.w / 2}%`,
          top: `${layout.photo.y - layout.photo.h / 2}%`,
          width: `${layout.photo.w}%`,
          height: `${layout.photo.h}%`,
          borderRadius: `${layout.photo.radius}%`,
        }}
      >
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt={person.name}
            crossOrigin="anonymous"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-white/70">
            No photo
          </div>
        )}
      </div>

      {/* QR */}
      <div
        className="absolute bg-white p-[2px]"
        style={{
          left: `${layout.qr.x - layout.qr.w / 2}%`,
          top: `${layout.qr.y - layout.qr.h / 2}%`,
          width: `${layout.qr.w}%`,
          height: `${layout.qr.h}%`,
        }}
      >
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="qr" className="h-full w-full object-contain" />
        ) : null}
      </div>

      {/* Name */}
      <div
        className="absolute"
        style={{
          left: `${layout.name.x - layout.name.w / 2}%`,
          top: `${layout.name.y}%`,
          width: `${layout.name.w}%`,
          color: layout.name.color,
          fontSize: `${(layout.name.fontSize / 100) * height}px`,
          fontWeight: layout.name.bold ? 700 : 500,
          textAlign: layout.name.align,
          lineHeight: 1.1,
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          letterSpacing: "0.02em",
        }}
      >
        {person.name}
      </div>
    </div>
  );
}

/** A high-resolution renderer used for PDF export. Renders to a canvas-friendly DOM. */
export function IDCardForExport({
  person,
  layout,
  width,
  forwardedRef,
}: Props & { forwardedRef?: React.Ref<HTMLDivElement> }) {
  const internal = useRef<HTMLDivElement>(null);
  return (
    <div ref={(forwardedRef as any) ?? internal}>
      <IDCard person={person} layout={layout} width={width} />
    </div>
  );
}
