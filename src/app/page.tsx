import { OceanView } from "@/components/ocean-view";
import { pageMetadata, SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { DEFAULT_STATION } from "@/lib/stations";

export const metadata = pageMetadata({ title: SITE_NAME, description: SITE_DESCRIPTION, path: "/" });

export default function Home() {
  return <OceanView station={DEFAULT_STATION} />;
}
