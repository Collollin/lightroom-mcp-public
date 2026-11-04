import { Ajv } from "ajv";
import type { Dispatcher } from "./dispatcher.js";
import type { ToolResponse } from "./tool-handler.js";
import { VERSION } from "./version.js";

export const OWNER_STATUS_TIMEOUT_MS = 1500;
export const BRIDGE_STATUS_TIMEOUT_MS = 2000;
export type Health = "disconnected" | "responsive" | "busy" | "unresponsive" | "unknown";
export type Observation<T> = { kind: "available"; value: T } | { kind: "unavailable"; reason: string };
export interface ConnectionEvidence {
  requestConnected: boolean;
  responseConnected: boolean;
  generation: number;
}
export interface OwnerStatus {
  version: string;
  health: Health;
  connection: ConnectionEvidence & { observedAt: string };
  probe: {
    startedAt: string | null;
    finishedAt: string;
    outcome: "reply" | "unsupported" | "timeout" | "not_sent" | "invalid" | "connection_changed" | "failed";
  };
  activeOperations: Observation<number>;
  pluginVersion: Observation<string>;
  lightroomVersion: Observation<string>;
  catalogPath: Observation<string>;
  registeredActions: Observation<string[]>;
}
export interface BridgeStatus {
  checkedAt: string;
  deadlineMs: number;
  server: { version: string; role: "none" | "leader" | "follower" };
  health: Health;
  owner: Observation<OwnerStatus>;
}

export const unavailable = (reason: string): { kind: "unavailable"; reason: string } => ({ kind: "unavailable", reason });
const observationSchema = (value: object) => ({
  oneOf: [
    { type: "object", required: ["kind", "value"], additionalProperties: false,
      properties: { kind: { const: "available" }, value } },
    { type: "object", required: ["kind", "reason"], additionalProperties: false,
      properties: { kind: { const: "unavailable" }, reason: { type: "string", minLength: 1 } } },
  ],
});
const stringObservation = observationSchema({ type: "string", minLength: 1 });
const metadataProperties = {
  activeOperations: observationSchema({ type: "integer", minimum: 0 }),
  pluginVersion: stringObservation,
  lightroomVersion: stringObservation,
  catalogPath: stringObservation,
  registeredActions: observationSchema({ type: "array", items: { type: "string" } }),
};
type PluginStatus = Pick<OwnerStatus, keyof typeof metadataProperties>;
const ajv = new Ajv({ strict: false });
const validatePluginStatus = ajv.compile<PluginStatus>({
  type: "object", required: Object.keys(metadataProperties), additionalProperties: false,
  properties: metadataProperties,
});
const ownerSchema = {
  type: "object", additionalProperties: false,
  required: ["version", "health", "connection", "probe", ...Object.keys(metadataProperties)],
  properties: {
    version: { type: "string", minLength: 1 },
    health: { enum: ["disconnected", "responsive", "busy", "unresponsive", "unknown"] },
    connection: { type: "object", additionalProperties: false,
      required: ["requestConnected", "responseConnected", "generation", "observedAt"],
      properties: { requestConnected: { type: "boolean" }, responseConnected: { type: "boolean" },
        generation: { type: "integer", minimum: 0 }, observedAt: { type: "string", minLength: 1 } } },
    probe: { type: "object", additionalProperties: false, required: ["startedAt", "finishedAt", "outcome"],
      properties: { startedAt: { type: ["string", "null"] }, finishedAt: { type: "string", minLength: 1 },
        outcome: { enum: ["reply", "unsupported", "timeout", "not_sent", "invalid", "connection_changed", "failed"] } } },
    ...metadataProperties,
  },
};
const validateOwnerReply = ajv.compile<{ owner: Observation<OwnerStatus> }>({
  type: "object", required: ["owner"], properties: { owner: observationSchema(ownerSchema) },
});

const validateToolResponse = ajv.compile<ToolResponse>({
  type: "object", required: ["content"], properties: {
    isError: { type: "boolean" }, content: { type: "array", minItems: 1,
      items: { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string" } } } },
  },
});

export function parseOwnerReply(response: unknown): Observation<OwnerStatus> {
  if (!validateToolResponse(response)) return unavailable("invalid_owner_reply");
  if (response.isError) {
    const message = response.content[0].text;
    return unavailable(message === "Owning bridge status deadline exceeded" ? "owner_timeout"
      : message === "Status request cancelled" || message === "Request cancelled" ? "cancelled" : "owner_status_unavailable");
  }
  let value: unknown;
  try { value = JSON.parse(response.content[0].text); } catch { return unavailable("invalid_owner_reply"); }
  return validateOwnerReply(value) ? value.owner : unavailable("invalid_owner_reply");
}

export function bridgeStatus(role: BridgeStatus["server"]["role"], owner: Observation<OwnerStatus>): BridgeStatus {
  return { checkedAt: new Date().toISOString(), deadlineMs: role === "follower" ? BRIDGE_STATUS_TIMEOUT_MS : OWNER_STATUS_TIMEOUT_MS,
    server: { version: VERSION, role }, health: owner.kind === "available" ? owner.value.health : "unknown", owner };
}

export function statusResponse(status: BridgeStatus): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(status) }] };
}

export function createOwnerStatusReader(deps: {
  dispatcher: Pick<Dispatcher, "call">;
  connection: () => ConnectionEvidence;
}): () => Promise<OwnerStatus> {
  return async () => {
    const connection = { ...deps.connection(), observedAt: new Date().toISOString() };
    let status: OwnerStatus = {
      version: VERSION, health: "disconnected", connection,
      probe: { startedAt: null, finishedAt: connection.observedAt, outcome: "not_sent" },
      activeOperations: unavailable("not_observed"), pluginVersion: unavailable("not_observed"),
      lightroomVersion: unavailable("not_observed"), catalogPath: unavailable("not_observed"),
      registeredActions: unavailable("not_observed"),
    };
    if (!connection.requestConnected || !connection.responseConnected) return status;
    status.probe.startedAt = new Date().toISOString();
    try {
      const reply = await deps.dispatcher.call("get_bridge_status", {}, OWNER_STATUS_TIMEOUT_MS);
      if (reply.error === "Unknown action: get_bridge_status") {
        status.health = "responsive";
        status.probe.outcome = "unsupported";
      } else if (!reply.error && validatePluginStatus(reply.result)) {
        status = { ...status, ...reply.result };
        status.health = reply.result.activeOperations.kind === "available" && reply.result.activeOperations.value > 0 ? "busy" : "responsive";
        status.probe.outcome = "reply";
      } else {
        status.health = "unknown";
        status.probe.outcome = "invalid";
      }
    } catch (error) {
      const timedOut = error instanceof Error && error.message.startsWith("Plugin response timeout");
      status.health = timedOut ? "unresponsive" : "unknown";
      status.probe.outcome = timedOut ? "timeout" : "failed";
    }
    const current = deps.connection();
    if (current.generation !== connection.generation || !current.requestConnected || !current.responseConnected) {
      return { version: VERSION, health: current.requestConnected && current.responseConnected ? "unknown" : "disconnected",
        connection: { ...current, observedAt: new Date().toISOString() },
        probe: { ...status.probe, finishedAt: new Date().toISOString(), outcome: "connection_changed" },
        activeOperations: unavailable("connection_changed"), pluginVersion: unavailable("connection_changed"),
        lightroomVersion: unavailable("connection_changed"), catalogPath: unavailable("connection_changed"),
        registeredActions: unavailable("connection_changed") };
    }
    status.probe.finishedAt = new Date().toISOString();
    return status;
  };
}
