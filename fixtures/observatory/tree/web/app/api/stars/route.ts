import { formatDeclination, formatRightAscension } from "@obs/web/format/angles";
import { Catalog } from "@obs/web/sky/catalog";

const DEFAULT_LIMIT = 20;

// GET /api/stars?limit=N: the N brightest stars, brightest first, with their places written
// out.
export function GET(request: Request): Response {
  const asked = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(asked) && asked > 0 ? asked : DEFAULT_LIMIT;
  const catalog = new Catalog();
  const stars = catalog.brightest(limit).map((star) => ({
    name: star.name,
    ra: formatRightAscension(star.ra),
    dec: formatDeclination(star.dec),
    magnitude: star.magnitude,
  }));
  return Response.json({ stars });
}
