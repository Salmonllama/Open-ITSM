import type { ReactNode } from 'react';
import { Logo } from './logo';
import { Card } from './ui/card';

/** Centred card with the lockup above it, for the screens shown before sign-in. */
export function AuthLayout({
  title,
  intro,
  width = 'max-w-sm',
  children,
}: {
  title: string;
  intro?: ReactNode;
  width?: string;
  children: ReactNode;
}) {
  return (
    <main className={`mx-auto flex w-full ${width} flex-col gap-6 px-4 py-16`}>
      <div className="flex justify-center">
        <Logo />
      </div>
      <Card className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 type-title">{title}</h1>
          {intro}
        </div>
        {children}
      </Card>
    </main>
  );
}
