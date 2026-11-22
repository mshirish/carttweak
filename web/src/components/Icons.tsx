export function Heart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
      <path d="M12 20.5s-7.5-4.6-9.4-9.2C1.2 7.9 3.4 4.5 6.9 4.5c2 0 3.6 1.1 5.1 3 1.5-1.9 3.1-3 5.1-3 3.5 0 5.7 3.4 4.3 6.8-1.9 4.6-9.4 9.2-9.4 9.2z" />
    </svg>
  );
}
