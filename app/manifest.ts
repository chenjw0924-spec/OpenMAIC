import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '课栈 KeStack',
    short_name: '课栈',
    description: 'AI 互动课堂。上传一份 PDF，即刻生成沉浸式、多智能体参与的学习体验。',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#722ed1',
    icons: [
      {
        src: '/openmaic-mark.png',
        sizes: 'any',
        type: 'image/png',
      },
    ],
  };
}