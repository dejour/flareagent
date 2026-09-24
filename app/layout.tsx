import type { Metadata } from 'next';
import './globals.css';
import './refined.css';
export const metadata: Metadata = {
  title: 'FlareAgent · 云端工作台',
  description: '在云端组织任务、项目与 Agent，查看执行过程并收取成果。',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
