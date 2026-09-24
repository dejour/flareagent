import type { Metadata } from 'next';
import './globals.css';
import './refined.css';
export const metadata: Metadata = {
  title: 'FlareAgent · 云端工作台',
  description: '在云端组织任务和项目，查看 Agent 对话与执行过程。',
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
