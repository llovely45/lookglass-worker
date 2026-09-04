import type {
  MonitorInput,
  MonitorKind,
  MonitorOrderInput,
  OrderItem,
  PanelInput,
  PanelOrderInput,
  PublicDestination,
  PublicDestinationResolver,
  ValidationResult,
} from "./types";

const MAX_NAME_LENGTH = 100;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_URL_LENGTH = 2048;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 256;
const CLOUDFLARE_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

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

type Ipv4Cidr = {
  readonly network: readonly [number, number, number, number];
  readonly prefix: number;
};

type Ipv6Cidr = {
  readonly network: readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  readonly prefix: number;
};

// IANA IPv4 Special-Purpose Address Registry, plus multicast. The broad
// protocol-assignment ranges intentionally deny more-specific public anycast
// reservations as well; probes may only use ordinary public unicast space.
const IPV4_DENYLIST: readonly Ipv4Cidr[] = [
  { network: [0, 0, 0, 0], prefix: 8 },
  { network: [10, 0, 0, 0], prefix: 8 },
  { network: [100, 64, 0, 0], prefix: 10 },
  { network: [127, 0, 0, 0], prefix: 8 },
  { network: [169, 254, 0, 0], prefix: 16 },
  { network: [168, 63, 129, 0], prefix: 24 },
  { network: [172, 16, 0, 0], prefix: 12 },
  { network: [192, 0, 0, 0], prefix: 24 },
  { network: [192, 0, 2, 0], prefix: 24 },
  { network: [192, 31, 196, 0], prefix: 24 },
  { network: [192, 52, 193, 0], prefix: 24 },
  { network: [192, 88, 99, 0], prefix: 24 },
  { network: [192, 168, 0, 0], prefix: 16 },
  { network: [192, 175, 48, 0], prefix: 24 },
  { network: [198, 18, 0, 0], prefix: 15 },
  { network: [198, 51, 100, 0], prefix: 24 },
  { network: [203, 0, 113, 0], prefix: 24 },
  { network: [224, 0, 0, 0], prefix: 4 },
  { network: [240, 0, 0, 0], prefix: 4 },
  { network: [255, 255, 255, 255], prefix: 32 },
];

// IANA IPv6 Special-Purpose Address Registry, plus multicast and deprecated
// IPv4-compatible space. This includes ranges whose registry entry is
// globally reachable today because they are protocol-specific, not ordinary
// monitor destinations.
const IPV6_DENYLIST: readonly Ipv6Cidr[] = [
  { network: [0, 0, 0, 0, 0, 0, 0, 0], prefix: 96 },
  { network: [0, 0, 0, 0, 0, 0xffff, 0, 0], prefix: 96 },
  { network: [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0], prefix: 96 },
  { network: [0x0064, 0xff9b, 1, 0, 0, 0, 0, 0], prefix: 48 },
  { network: [0x0100, 0, 0, 0, 0, 0, 0, 0], prefix: 64 },
  { network: [0x0100, 0, 0, 1, 0, 0, 0, 0], prefix: 64 },
  { network: [0x2001, 0, 0, 0, 0, 0, 0, 0], prefix: 23 },
  { network: [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], prefix: 32 },
  { network: [0x2002, 0, 0, 0, 0, 0, 0, 0], prefix: 16 },
  { network: [0x2620, 0x004f, 0x8000, 0, 0, 0, 0, 0], prefix: 48 },
  { network: [0x3fff, 0, 0, 0, 0, 0, 0, 0], prefix: 20 },
  { network: [0x5f00, 0, 0, 0, 0, 0, 0, 0], prefix: 16 },
  { network: [0xfc00, 0, 0, 0, 0, 0, 0, 0], prefix: 7 },
  { network: [0xfe80, 0, 0, 0, 0, 0, 0, 0], prefix: 10 },
  { network: [0xff00, 0, 0, 0, 0, 0, 0, 0], prefix: 8 },
];

function isIpv4InCidr(octets: [number, number, number, number], range: Ipv4Cidr): boolean {
  const fullOctets = Math.floor(range.prefix / 8);
  for (let index = 0; index < fullOctets; index += 1) {
    if (octets[index] !== range.network[index]) {
      return false;
    }
  }

  const remainingBits = range.prefix % 8;
  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    (octets[fullOctets] & mask) ===
    (range.network[fullOctets] & mask)
  );
}

function isIpv6InCidr(groups: number[], range: Ipv6Cidr): boolean {
  const fullGroups = Math.floor(range.prefix / 16);
  for (let index = 0; index < fullGroups; index += 1) {
    if (groups[index] !== range.network[index]) {
      return false;
    }
  }

  const remainingBits = range.prefix % 16;
  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (
    (groups[fullGroups] & mask) ===
    (range.network[fullGroups] & mask)
  );
}

function isPublicIpv4(octets: [number, number, number, number]): boolean {
  return !IPV4_DENYLIST.some((range) => isIpv4InCidr(octets, range));
}

function isPublicIpv6(groups: number[]): boolean {
  if (groups[0] === 0 || groups[0] === 0xffff) {
    return false;
  }
  return !IPV6_DENYLIST.some((range) => isIpv6InCidr(groups, range));
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

export interface PublicDestinationValidationOptions {
  resolver?: PublicDestinationResolver;
  fetcher?: typeof fetch;
}

function normalizePublicIpLiteral(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value !== value.trim() || hasControlCharacters(value)) {
    return null;
  }

  const withoutBrackets = stripIpv6Brackets(value);
  if (!withoutBrackets) {
    return null;
  }

  const ip = parseIpLiteral(withoutBrackets);
  if (!ip) {
    return null;
  }

  return ip.kind === "ipv4"
    ? isPublicIpv4(ip.octets)
      ? withoutBrackets
      : null
    : isPublicIpv6(ip.groups)
      ? withoutBrackets
      : null;
}

type DnsRecordType = 1 | 28;

function parseDnsJsonAnswers(
  payload: unknown,
  recordType: DnsRecordType,
): string[] | null {
  if (!isInputRecord(payload) || payload.Status !== 0) {
    return null;
  }

  if (payload.Answer === undefined) {
    return [];
  }
  if (!Array.isArray(payload.Answer)) {
    return null;
  }

  const addresses: string[] = [];
  for (const answer of payload.Answer) {
    if (!isInputRecord(answer)) {
      return null;
    }
    if (answer.type !== recordType) {
      continue;
    }
    if (typeof answer.data !== "string") {
      return null;
    }
    addresses.push(answer.data);
  }

  return addresses;
}

async function queryCloudflareDns(
  hostname: string,
  type: "A" | "AAAA",
  recordType: DnsRecordType,
  fetcher: typeof fetch,
): Promise<string[]> {
  const url = new URL(CLOUDFLARE_DOH_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);

  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
  });
  if (!response.ok) {
    throw new Error("DNS query failed");
  }

  const payload: unknown = await response.json();
  const addresses = parseDnsJsonAnswers(payload, recordType);
  if (!addresses) {
    throw new Error("DNS response is invalid");
  }
  return addresses;
}

async function resolveWithCloudflareDns(
  hostname: string,
  fetcher: typeof fetch,
): Promise<readonly string[]> {
  const [ipv4, ipv6] = await Promise.all([
    queryCloudflareDns(hostname, "A", 1, fetcher),
    queryCloudflareDns(hostname, "AAAA", 28, fetcher),
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0) {
    throw new Error("DNS returned no addresses");
  }
  return addresses;
}

/**
 * Revalidate a destination immediately before Task 4 probes it. Hostnames
 * are resolved through the injected resolver or Cloudflare DoH, and every
 * returned address must be a public IP literal. Literal destinations retain
 * the synchronous checks and do not perform a DNS query.
 */
export async function validatePublicDestination(
  value: unknown,
  options: PublicDestinationValidationOptions = {},
): Promise<ValidationResult<PublicDestination>> {
  const host = normalizedDestinationHost(extractDestinationHost(value));
  if (!host) {
    return failure("destination must be a public host or IP");
  }

  if (parseIpLiteral(host)) {
    return {
      ok: true,
      value: { host, addresses: [host] },
    };
  }

  const resolver = options.resolver ?? ((hostname: string) =>
    resolveWithCloudflareDns(hostname, options.fetcher ?? fetch));

  let resolvedAddresses: readonly string[];
  try {
    resolvedAddresses = await resolver(host);
  } catch {
    return failure("destination DNS resolution failed");
  }

  if (!Array.isArray(resolvedAddresses) || resolvedAddresses.length === 0) {
    return failure("destination DNS returned no addresses");
  }

  const addresses: string[] = [];
  for (const address of resolvedAddresses) {
    const normalizedAddress = normalizePublicIpLiteral(address);
    if (!normalizedAddress) {
      return failure("destination DNS returned a non-public address");
    }
    addresses.push(normalizedAddress);
  }

  return {
    ok: true,
    value: { host, addresses },
  };
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

function validateNavigationLink(value: unknown): ValidationResult<string | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  const result = validateUrl(value, ["http:", "https:"]);
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

function validateOrderItems(value: unknown): ValidationResult<OrderItem[]> {
  if (!Array.isArray(value)) {
    return failure("items must be an array");
  }

  const ids = new Set<string>();
  const sortOrders = new Set<number>();
  const items: OrderItem[] = [];
  for (const item of value) {
    if (!isInputRecord(item)) {
      return failure("each order item must be an object");
    }

    const id = validateIdentifier(item.id, "items.id");
    if (!id.ok) {
      return id;
    }
    if (ids.has(id.value)) {
      return failure("items must not contain duplicate ids");
    }
    ids.add(id.value);

    if (!("sort_order" in item)) {
      return failure("items.sort_order must be an integer");
    }
    const sortOrder = validateSortOrder(item.sort_order);
    if (!sortOrder.ok) {
      return sortOrder;
    }
    if (sortOrders.has(sortOrder.value)) {
      return failure("sort_order values must be distinct");
    }
    sortOrders.add(sortOrder.value);
    items.push({ id: id.value, sort_order: sortOrder.value });
  }

  return { ok: true, value: items };
}

export function validatePanelOrderInput(
  input: unknown,
): ValidationResult<PanelOrderInput> {
  if (!isInputRecord(input)) {
    return failure("panel order input must be an object");
  }
  const items = validateOrderItems(input.items);
  return items.ok ? { ok: true, value: { items: items.value } } : items;
}

export function validateMonitorOrderInput(
  input: unknown,
): ValidationResult<MonitorOrderInput> {
  if (!isInputRecord(input)) {
    return failure("monitor order input must be an object");
  }
  const panelId = validateIdentifier(input.panel_id, "panel_id");
  if (!panelId.ok) {
    return panelId;
  }
  const items = validateOrderItems(input.items);
  return items.ok
    ? { ok: true, value: { panel_id: panelId.value, items: items.value } }
    : items;
}

function validateEnabled(value: unknown): ValidationResult<boolean> {
  if (value === undefined) {
    return { ok: true, value: true };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : failure("enabled must be a boolean");
}

function validateNavOnly(value: unknown): ValidationResult<boolean> {
  if (value === undefined) {
    return { ok: true, value: false };
  }
  return typeof value === "boolean"
    ? { ok: true, value }
    : failure("nav_only must be a boolean");
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
  const navOnly = validateNavOnly(input.nav_only);
  if (!navOnly.ok) {
    return navOnly;
  }

  return {
    ok: true,
    value: {
      name: name.value,
      logo_url: logoUrl.value,
      nav_only: navOnly.value,
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
  const linkUrl = validateNavigationLink(input.link_url);
  if (!linkUrl.ok) {
    return linkUrl;
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
      link_url: linkUrl.value,
      kind,
      target,
      port,
      sort_order: sortOrder.value,
      enabled: enabled.value,
    },
  };
}
