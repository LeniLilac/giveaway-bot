"use client";

import { useEffect, useState } from "react";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatLocalTime(value: string, dateOnly: boolean): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Invalid date";
  return (dateOnly ? dateFormatter : dateTimeFormatter).format(parsed);
}

function useLocalTime(value: string | null, dateOnly = false): string | null {
  const [formatted, setFormatted] = useState<string | null>(null);

  useEffect(() => {
    setFormatted(value ? formatLocalTime(value, dateOnly) : null);
  }, [dateOnly, value]);

  return formatted;
}

export function LocalTime({
  value,
  dateOnly = false,
  fallback = "Not yet",
}: {
  value: string | null;
  dateOnly?: boolean;
  fallback?: string;
}): React.ReactElement {
  const formatted = useLocalTime(value, dateOnly);
  if (!value) return <>{fallback}</>;

  return (
    <time dateTime={value} aria-label={formatted ?? "Local time"}>
      {formatted ?? "..."}
    </time>
  );
}

export function LocalTimeTitle({
  value,
  suffix,
  className,
  children,
}: {
  value: string;
  suffix: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const formatted = useLocalTime(value);
  return (
    <div className={className} title={formatted ? `${formatted}: ${suffix}` : suffix}>
      {children}
    </div>
  );
}
