import type {
  OrderedEventEnvelope,
  ProtocolError,
  ServerInfo,
  WelcomeMessage,
} from "@gitgui/contracts";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "incompatible"
  | "unauthorized"
  | "failed"
  | "disconnected";

export interface ConnectionStateChange {
  previous: ConnectionState;
  current: ConnectionState;
  error?: Error;
}

export interface WebSocketMessageEvent {
  data: unknown;
}

export interface WebSocketCloseEvent {
  code: number;
  reason: string;
}

/** The small browser WebSocket surface required by GitGuiClient. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: WebSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface GitGuiClientOptions {
  endpoint: string | URL;
  /** Short-lived single-use ticket used only for the WebSocket handshake. */
  webSocketTicket?: string;
  expectedProtocolVersion?: number;
  webSocketFactory?: WebSocketFactory;
  requestTimeoutMs?: number;
}

export type StateListener = (change: ConnectionStateChange) => void;
export type OrderedEventListener = (event: OrderedEventEnvelope) => void;
export type TypedEventListener = (event: OrderedEventEnvelope) => void;

export interface WelcomeState {
  message: WelcomeMessage;
  connectedAt: number;
}

export interface ClientProtocolFailure {
  error: ProtocolError;
  requestId?: string;
}

export type Unsubscribe = () => void;

export type ServerMetadata = Pick<ServerInfo, "environment_id" | "server_id" | "protocol_version" | "capabilities">;
