import type {
  MonitorInput,
  MonitorKind,
  PanelInput,
  ValidationResult,
} from "./types";

const MAX_NAME_LENGTH = 100;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 256;

const MONITOR_KINDS = new Set<MonitorKind>(["http_get", "tcping"]);

const LOCAL_HOSTNAMES = new Set([
  "broadcasthost",
  "ip6-allnodes",
  "ip6-allrouters",
  "ip6-localhost",
  "ip6-loopback",
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata.azure.internal",
  "instance-data",
]);

const LOCAL_HOSTNAME_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".invalid",
  ".test",
  ".example",
];

type ParsedIp =
  | { kind: "ipv4"; octets: [number, number, number, number] }
  | { kind: "ipv6"; groups: number[] };

type InputRecord = Record<string, unknown>;

function failure(message: string): { ok: false; message: string } {
  return {
    ok: false,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function isInputRecord(value: unknown): value is InputRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function parseIpv4(value: string): [number, number, number, number] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return null;
  }

  const parts = value.split(".");
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return null;
  }

  return octets as [number, number, number, number];
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(":") || value.includes("%")) {
    return null;
  }

  const compressionParts = value.split("::");
  if (compressionParts.length > 2) {
    return null;
  }

  const parsePart = (part: string, allowIpv4: boolean): number[] | null => {
    if (part === "") {
      return [];
    }

    const pieces = part.split(":");
    const groups: number[] = [];
    const lastPiece = pieces.at(-1);

    if (lastPiece?.includes(".")) {
      if (!allowIpv4) {
        return null;
      }
      const ipv4 = parseIpv4(lastPiece);
      if (!ipv4) {
        return null;
      }
      pieces.pop();
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    }

    for (const piece of pieces) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        return null;
      }
      groups.push(Number.parseInt(piece, 16));
    }

    return groups;
  };

  const hasCompression = compressionParts.length === 2;
  const left = parsePart(compressionParts[0], !hasCompression);
  const right = hasCompression ? parsePart(compressionParts[1], true) : [];
  if (!left || !right) {
    return null;
  }

  const groupCount = left.length + right.length;
  if (compressionParts.length === 1) {
    return groupCount === 8 ? left : null;
  }
  if (groupCount >= 8) {
    return null;
  }

  return [...left, ...Array.from({ length: 8 - groupCount }, () => 0), ...right];
}

function parseIpLiteral(value: string): ParsedIp | null {
  const ipv4 = parseIpv4(value);
  if (ipv4) {
    return { kind: "ipv4", octets: ipv4 };
  }

  const ipv6 = parseIpv6(value);
  if (ipv6) {
    return { kind: "ipv6", groups: ipv6 };
  }

  return null;
}

function isIpv4InRange(
  octets: [number, number, number, number],
  first: number,
  secondMin: number,
  secondMax: number,
): boolean {
  return (
    octets[0] === first &&
    octets[1] >= secondMin &&
    octets[1] <= secondMax
  );
}

function isPublicIpv4(octets: [number, number, number, number]): boolean {
  const [first, second, third] = octets;
  const isNetwork = (networkFirst: number, networkSecond: number, networkThird: number) =>
    first === networkFirst &&
    second === networkSecond &&
    third === networkThird;

  if (
    first === 0 ||
    first === 127 ||
    isIpv4InRange(octets, 10, 0, 255) ||
    isIpv4InRange(octets, 100, 64, 127) ||
    isIpv4InRange(octets, 169, 254, 254) ||
    isIpv4InRange(octets, 172, 16, 31) ||
    isIpv4InRange(octets, 192, 168, 168) ||
    isIpv4InRange(octets, 198, 18, 19) ||
    first >= 224
  ) {
    return false;
  }

  if (
    isNetwork(192, 0, 0) ||
    isNetwork(192, 0, 2) ||
    isNetwork(198, 51, 100) ||
    isNetwork(203, 0, 113) ||
    isNetwork(192, 88, 99) ||
    isNetwork(168, 63, 129)
  ) {
    return false;
  }

  return true;
}

function hasIpv6Prefix(groups: number[], prefix: number, expected: number[]): boolean {
  const fullGroups = Math.floor(prefix / 16);
  for (let index = 0; index < fullGroups; index += 1) {
    if (groups[index] !== (expected[index] ?? 0)) {
      return false;
    }
  }

  const remainingBits = prefix % 16;
  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (
    (groups[fullGroups] & mask) ===
    ((expected[fullGroups] ?? 0) & mask)
  );
}

function last32BitsAsIpv4(groups: number[]): [number, number, number, number] {
  const first = groups[6];
  const second = groups[7];
  return [first >> 8, first & 0xff, second >> 8, second & 0xff];
}

function isPublicIpv6(groups: number[]): boolean {
  const allZero = groups.every((group) => group === 0);
  if (allZero) {
    return false;
  }

  const isMappedIpv4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isCompatibleIpv4 = groups.slice(0, 6).every((group) => group === 0);
  if (isMappedIpv4) {
    return isPublicIpv4(last32BitsAsIpv4(groups));
  }
  if (isCompatibleIpv4) {
    return false;
  }

  if (groups[0] === 0) {
    return false;
  }

  if (
    hasIpv6Prefix(groups, 7, [0xfc00]) ||
    hasIpv6Prefix(groups, 10, [0xfe80]) ||
    hasIpv6Prefix(groups, 8, [0xff00]) ||
    hasIpv6Prefix(groups, 32, [0x2001, 0x0db8]) ||
    hasIpv6Prefix(groups, 48, [0x2001, 0x0002]) ||
    hasIpv6Prefix(groups, 28, [0x2001, 0x0010]) ||
    hasIpv6Prefix(groups, 28, [0x2001, 0x0020]) ||
    hasIpv6Prefix(groups, 20, [0x3fff]) ||
    hasIpv6Prefix(groups, 16, [0xffff]) ||
    hasIpv6Prefix(groups, 64, [0x0100, 0x0000, 0x0000, 0x0000])
  ) {
    return false;
  }

  return true;
}

function stripIpv6Brackets(value: string): string | null {
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) {
      return null;
    }
    const inner = value.slice(1, -1);
    return (
      inner.length > 0 &&
      inner.includes(":") &&
      !inner.includes("[") &&
      !inner.includes("]")
    )
      ? inner
      : null;
  }
  return value;
}

function isReservedHostname(hostname: string): boolean {
  const comparable = hostname.endsWith(".")
    ? hostname.slice(0, -1)
    : hostname;
  const lower = comparable.toLowerCase();

  return (
    LOCAL_HOSTNAMES.has(lower) ||
    lower === "example" ||
    LOCAL_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

function isValidHostname(value: string): boolean {
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  if (
    hostname.length === 0 ||
    hostname.length > MAX_HOST_LENGTH ||
    isReservedHostname(value)
  ) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }

  if (labels.some((label) => label.length === 0 || label.length > MAX_LABEL_LENGTH)) {
    return false;
  }

  if (
    labels.some(
      (label) =>
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
    )
  ) {
    return false;
  }

  if (labels.every((label) => /^\d+$/.test(label))) {
    return false;
  }

  return true;
}

function normalizedDestinationHost(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (
    value.length > MAX_HOST_LENGTH + 2 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    return null;
  }

  const withoutBrackets = stripIpv6Brackets(value);
  if (!withoutBrackets || withoutBrackets.length === 0) {
    return null;
  }

  const ip = parseIpLiteral(withoutBrackets);
  if (ip) {
    return ip.kind === "ipv4"
      ? isPublicIpv4(ip.octets)
        ? withoutBrackets
        : null
      : isPublicIpv6(ip.groups)
        ? withoutBrackets
        : null;
  }

  if (withoutBrackets.includes(":")) {
    return null;
  }

  if (!isValidHostname(withoutBrackets)) {
    return null;
  }

  return withoutBrackets;
}

function extractDestinationHost(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (hasUrlCredentials(value, url)) {
        return null;
      }
      return url.hostname;
    } catch {
      return null;
    }
  }

  return value;
}

function hasUrlCredentials(value: string, url: URL): boolean {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  return Boolean(url.username || url.password || authority?.includes("@"));
}

export function isPublicDestination(value: unknown): boolean {
  return normalizedDestinationHost(extractDestinationHost(value)) !== null;
}

function validateUrl(value: unknown, protocols: readonly string[]): ValidationResult<string> {
  if (typeof value !== "string") {
    return failure("URL must be a string");
  }
  if (value.length === 0 || value.length > MAX_URL_LENGTH) {
    return failure("URL length is invalid");
  }
  if (value !== value.trim() || hasControlCharacters(value)) {
    return failure("URL contains invalid whitespace");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failure("URL is invalid");
  }

  if (!protocols.includes(url.protocol)) {
    return failure("URL scheme is not allowed");
  }
  if (hasUrlCredentials(value, url)) {
    return failure("URL credentials are not allowed");
  }
  if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1)) {
    return failure("URL port is invalid");
  }
  if (!isPublicDestination(url.hostname)) {
    return failure("URL destination must be public");
  }

  return { ok: true, value };
}

export function validateHttpTarget(
  value: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  return validateUrl(value, ["http:", "https:"]);
}

function validateHttpsLogo(value: unknown): ValidationResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  const result = validateUrl(value, ["https:"]);
  return result.ok ? result : failure(result.message);
}

function validateName(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return failure("name must be a string");
  }
  if (hasControlCharacters(value)) {
    return failure("name is too long or contains control characters");
  }
  const name = value.trim();
  if (name.length === 0) {
    return failure("name must not be empty");
  }
  if (name.length > MAX_NAME_LENGTH) {
    return failure("name is too long or contains control characters");
  }
  return { ok: true, value: name };
}

function validateIdentifier(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return failure(`${field} must be a non-empty string`);
  }
  if (
    value.length > MAX_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    return failure(`${field} is invalid`);
  }
  return { ok: true, value };
}

function validateSortOrder(value: unknown): ValidationResult<number> {
  if (value === undefined) {
    return { ok: true, value: 0 };
  }
  if (!Number.isSafeInteger(value)) {
    return failure("sort_order must be an integer");
  }
  return { ok: true, value: value as number };
}

function validateEnabled(value: unknown): ValidationResult<boolean> {
  if (value === undefined) {
    return { ok: true, value: true };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : failure("enabled must be a boolean");
}

export function validateTcpTarget(
  host: unknown,
  port: unknown,
): { ok: true; host: string; port: number } | { ok: false; message: string } {
  const normalizedHost = normalizedDestinationHost(host);
  if (!normalizedHost || !isPublicDestination(host)) {
    return failure("TCP destination must be a public host or IP");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return failure("TCP port must be an integer from 1 through 65535");
  }

  return { ok: true, host: normalizedHost, port };
}

export function validatePanelInput(input: unknown): ValidationResult<PanelInput> {
  if (!isInputRecord(input)) {
    return failure("panel input must be an object");
  }

  const name = validateName(input.name);
  if (!name.ok) {
    return name;
  }
  const logoUrl = validateHttpsLogo(input.logo_url);
  if (!logoUrl.ok) {
    return logoUrl;
  }
  const sortOrder = validateSortOrder(input.sort_order);
  if (!sortOrder.ok) {
    return sortOrder;
  }
  const enabled = validateEnabled(input.enabled);
  if (!enabled.ok) {
    return enabled;
  }

  return {
    ok: true,
    value: {
      name: name.value,
      logo_url: logoUrl.value,
      sort_order: sortOrder.value,
      enabled: enabled.value,
    },
  };
}

export function validateMonitorInput(input: unknown): ValidationResult<MonitorInput> {
  if (!isInputRecord(input)) {
    return failure("monitor input must be an object");
  }

  const panelId = validateIdentifier(input.panel_id, "panel_id");
  if (!panelId.ok) {
    return panelId;
  }
  const name = validateName(input.name);
  if (!name.ok) {
    return name;
  }
  const logoUrl = validateHttpsLogo(input.logo_url);
  if (!logoUrl.ok) {
    return logoUrl;
  }
  if (typeof input.kind !== "string" || !MONITOR_KINDS.has(input.kind as MonitorKind)) {
    return failure("kind must be http_get or tcping");
  }

  const kind = input.kind as MonitorKind;
  let target: string;
  let port: number | null;
  if (kind === "http_get") {
    if (input.port !== undefined && input.port !== null) {
      return failure("HTTP monitors must have a null port");
    }
    const httpTarget = validateHttpTarget(input.target);
    if (!httpTarget.ok) {
      return httpTarget;
    }
    target = httpTarget.value;
    port = null;
  } else {
    const tcpTarget = validateTcpTarget(input.target, input.port);
    if (!tcpTarget.ok) {
      return tcpTarget;
    }
    target = tcpTarget.host;
    port = tcpTarget.port;
  }

  const sortOrder = validateSortOrder(input.sort_order);
  if (!sortOrder.ok) {
    return sortOrder;
  }
  const enabled = validateEnabled(input.enabled);
  if (!enabled.ok) {
    return enabled;
  }

  return {
    ok: true,
    value: {
      panel_id: panelId.value,
      name: name.value,
      logo_url: logoUrl.value,
      kind,
      target,
      port,
      sort_order: sortOrder.value,
      enabled: enabled.value,
    },
  };
}
