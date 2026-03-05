import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Navbar } from './components/Navbar';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Prompt Engine',
  description: 'Automated prompt generation, testing, and refinement',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.variable} style={{ fontFamily: 'var(--font-inter), system-ui, sans-serif', margin: 0 }}>
        <Navbar />
        <main>{children}</main>
      </body>
    </html>
  );
}
