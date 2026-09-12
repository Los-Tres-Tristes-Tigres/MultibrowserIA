import { Globe, Github } from "lucide-react";

export function AppIcon({
  preset,
  size = 28,
}: {
  preset: string;
  size?: number;
}) {
  if (preset === "gmail")
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M3 8v17h5V12"
          stroke="#4285f4"
          strokeWidth="2"
          fill="#4285f4"
        />
        <path
          d="M24 12v13h5V8"
          fill="#34a853"
          stroke="#34a853"
          strokeWidth="2"
        />
        <path
          d="m4 7 12 9L28 7"
          fill="none"
          stroke="#ea4335"
          strokeWidth="6"
          strokeLinejoin="round"
        />
        <path d="m3 7 5 4V6.8C4 3.5 2 5 3 7" fill="#c5221f" />
        <path d="m24 11 5-4c1-2-1-3.5-5-.2" fill="#fbbc04" />
      </svg>
    );
  if (preset === "calendar")
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <path d="M3 2h26v23l-5 5H3z" fill="#4285f4" />
        <path d="M8 8h18v17H8z" fill="#fff" />
        <path d="M3 25h21v5H3z" fill="#34a853" />
        <path d="M3 8h5v17H3z" fill="#fbbc04" />
        <path d="M24 25h5l-5 5z" fill="#ea4335" />
        <text
          x="17"
          y="21"
          textAnchor="middle"
          fontFamily="Arial"
          fontSize="12"
          fontWeight="bold"
          fill="#4285f4"
        >
          31
        </text>
      </svg>
    );
  if (preset === "slack")
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M12 3v11M3 12h5"
          stroke="#36c5f0"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M29 12H18M20 3v5"
          stroke="#2eb67d"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M20 29V18M29 20h-5"
          stroke="#ecb22e"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <path
          d="M3 20h11M12 29v-5"
          stroke="#e01e5a"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
    );
  if (preset === "github")
    return (
      <Github
        size={size}
        fill="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      />
    );
  if (preset === "notion")
    return (
      <span
        className="notion-icon"
        style={{ width: size, height: size, fontSize: size * 0.7 }}
        aria-hidden="true"
      >
        N
      </span>
    );
  if (preset === "outlook")
    return (
      <span
        className="outlook-icon"
        style={{ width: size, height: size, fontSize: size * 0.55 }}
        aria-hidden="true"
      >
        O
      </span>
    );
  return (
    <Globe
      size={size}
      strokeWidth={1.6}
      className="custom-icon"
      aria-hidden="true"
    />
  );
}
export function OrbitLogo() {
  return <img src="/orbit.svg" alt="" width="38" height="38" />;
}
