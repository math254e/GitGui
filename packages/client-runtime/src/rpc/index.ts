export { assertRepositoryId, GitGuiClient } from "./client";
export {
  GitGuiClientError,
  connectionError,
  isUnauthorizedError,
  protocolErrorToClientError,
} from "./errors";
export { OrderedEventBus, type SequenceGap, type SequenceGapListener } from "./events";
export {
  resolveEndpoint,
  toHttpUrl,
  toWebSocketUrl,
  WEBSOCKET_TICKET_QUERY_KEY,
  type EndpointUrls,
} from "./urls";
export type {
  ConnectionState,
  ConnectionStateChange,
  GitGuiClientOptions,
  OrderedEventListener,
  StateListener,
  Unsubscribe,
  WebSocketFactory,
  WebSocketLike,
} from "./types";
