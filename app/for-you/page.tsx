import type { Metadata } from 'next';
import FlowerStory from './FlowerStory';

export const metadata: Metadata = {
  title: 'M\u1ed9t th\u1ee9 nh\u1ecf d\u00e0nh cho b\u1ea1n',
  description: 'M\u1edf th\u1eed nh\u00e9.',
};

export default function ForYouPage() {
  return <FlowerStory />;
}
