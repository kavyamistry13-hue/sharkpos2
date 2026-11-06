export function LogoMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#183850" />
      <path d="M6 21c4-1 6-6 9-12 1 5 4 9 11 12-4 2-8 1-10-1-3 2-7 2-10 1z" fill="#4a97ee" />
    </svg>
  );
}
export function Wordmark({ dark }) {
  return (
    <span className={`text-[17px] font-extrabold tracking-tight ${dark ? 'text-white' : 'text-text'}`}>
      SHARKPOS<span className="ml-1 text-[#4a97ee]">AI</span>
    </span>
  );
}
