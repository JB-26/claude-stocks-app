import { NextResponse } from "next/server";
import { getCompanyProfile } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import type { ProfileResponse } from "@/lib/finnhub/types";

const PROFILE_TTL_MS = 60 * 60_000; // 1 hour — logos rarely change
const SYMBOL_RE = /^[A-Z]{1,10}$/;

export async function GET(request: Request) {
  if (!checkRateLimit(request)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";

  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const cacheKey = `profile:${symbol}`;
  const cached = getCached<ProfileResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const raw = await getCompanyProfile(symbol);

    const response: ProfileResponse = {
      logo: raw.logo ?? "",
      name: raw.name ?? "",
    };

    setCached(cacheKey, response, PROFILE_TTL_MS);
    return NextResponse.json(response);
  } catch (err) {
    console.error("[/api/stock/profile]", err);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }
}
