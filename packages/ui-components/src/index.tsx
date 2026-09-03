import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'quiet' | 'danger' }) {
  const { tone = 'primary', className = '', ...rest } = props;
  return <button className={`button button--${tone} ${className}`} {...rest} />;
}

export function Card(props: HTMLAttributes<HTMLElement> & { title?: string; action?: ReactNode }) {
  const { title, action, children, className = '', ...rest } = props;
  return (
    <section className={`card ${className}`} {...rest}>
      {(title || action) && <header className="card__header"><h2>{title}</h2>{action}</header>}
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
