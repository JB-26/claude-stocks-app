"use client";

import { useState, useEffect } from "react";
import type { ProfileResponse } from "@/lib/finnhub/types";

interface Props {
  symbol: string;
}

export default function CompanyLogo({ symbol }: Props) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setLogoUrl(null);
    setImgFailed(false);

    fetch(`/api/stock/profile?symbol=${symbol}`)
      .then((res) => {
        if (!res.ok) return;
        return res.json() as Promise<ProfileResponse>;
      })
      .then((data) => {
        if (data?.logo) setLogoUrl(data.logo);
      })
      .catch(() => {});
  }, [symbol]);

  if (!logoUrl || imgFailed) return null;

  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-800 p-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logoUrl}
        alt={`${symbol} logo`}
        className="h-full w-full object-contain"
        onError={() => setImgFailed(true)}
      />
    </div>
  );
}
