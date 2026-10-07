import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OceanView } from "@/components/ocean-view";
import { pageMetadata, SITE_NAME } from "@/lib/site";
import { DEFAULT_STATION, slug, STATIONS, stationBySlug, stationPath } from "@/lib/stations";

export const dynamicParams = false;

export function generateStaticParams() {
  // The default station is the home page; its name redirects there.
  return STATIONS.filter((s) => s !== DEFAULT_STATION).map((s) => ({ station: slug(s) }));
}

export async function generateMetadata({ params }: PageProps<"/[station]">): Promise<Metadata> {
  const station = stationBySlug((await params).station);
  if (!station) return { title: SITE_NAME };
  return pageMetadata({
    title: `${SITE_NAME} · ${station.name}`,
    description: `The sea at ${station.name}, rebuilt live from what its wave buoy measured.`,
    path: stationPath(station),
  });
}

export default async function StationPage({ params }: PageProps<"/[station]">) {
  const station = stationBySlug((await params).station);
  if (!station || station === DEFAULT_STATION) notFound();
  return <OceanView station={station} />;
}
