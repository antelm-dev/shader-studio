import { FeatureStrip } from '@/components/home/feature-strip';
import { Hero } from '@/components/home/hero';
import { Playground } from '@/components/home/playground';

export default function HomePage() {
  return (
    <>
      <Hero />
      <FeatureStrip />
      <Playground />
    </>
  );
}
