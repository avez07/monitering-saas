import protobuf from 'protobufjs';

/**
 * The OTLP/HTTP request and response messages (opentelemetry-proto v1.x field numbers), as much of them as
 * the ingest needs. Written out here, not generated, so there is no build step; unknown fields in a
 * request are skipped by protobufjs, so newer SDKs keep working. Metrics are only counted, so their
 * data points are declared as opaque bytes.
 */
const PROTO = `
syntax = "proto3";
package otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; }
message Resource { repeated KeyValue attributes = 1; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  repeated SpanEvent events = 11;
  repeated SpanLink links = 13;
  SpanStatus status = 15;
}
message SpanEvent { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message SpanLink { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; }
message SpanStatus { string message = 2; int32 code = 3; }
message ExportTraceServiceResponse { TracePartialSuccess partial_success = 1; }
message TracePartialSuccess { int64 rejected_spans = 1; string error_message = 2; }

message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  fixed64 observed_time_unix_nano = 11;
}
message ExportLogsServiceResponse { LogsPartialSuccess partial_success = 1; }
message LogsPartialSuccess { int64 rejected_log_records = 1; string error_message = 2; }

message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; }
message Metric {
  string name = 1;
  Points gauge = 5;
  Points sum = 7;
  Points histogram = 9;
  Points exponential_histogram = 10;
  Points summary = 11;
}
message Points { repeated bytes data_points = 1; }
message ExportMetricsServiceResponse { MetricsPartialSuccess partial_success = 1; }
message MetricsPartialSuccess { int64 rejected_data_points = 1; string error_message = 2; }
`;

const root = protobuf.parse(PROTO, { keepCase: false }).root;
const TYPES = {
  traces: { request: root.lookupType('otlp.ExportTraceServiceRequest'), response: root.lookupType('otlp.ExportTraceServiceResponse') },
  logs: { request: root.lookupType('otlp.ExportLogsServiceRequest'), response: root.lookupType('otlp.ExportLogsServiceResponse') },
  metrics: { request: root.lookupType('otlp.ExportMetricsServiceRequest'), response: root.lookupType('otlp.ExportMetricsServiceResponse') },
};
export const SIGNALS = Object.keys(TYPES);

const TO_OBJECT = { longs: String, bytes: String, enums: Number, defaults: false, arrays: false, objects: false };

export const isProtobufType = (contentType = '') => /^application\/(x-)?protobuf\b/i.test(contentType);
export const isJsonType = (contentType = '') => /^application\/json\b/i.test(contentType);

/**
 * Decode a request body. Returns the plain object in OTLP/JSON shape (camelCase, 64-bit numbers as
 * strings) plus `proto`, which says how trace/span ids are written (protobuf bytes arrive base64-encoded
 * here; OTLP/JSON already uses hex). Throws a plain Error when the body is not valid.
 */
export function decodeRequest(signal, body, contentType) {
  const type = TYPES[signal].request;
  if (isProtobufType(contentType)) {
    const message = type.decode(body);
    return { proto: true, data: type.toObject(message, TO_OBJECT) };
  }
  const text = body.length ? body.toString('utf8') : '{}';
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The JSON body must be an object.');
  return { proto: false, data };
}

/** The response body for an accepted request, in the request's own format. */
export function encodeResponse(signal, { json, rejected = 0, message = '' }) {
  const field = { traces: 'rejectedSpans', logs: 'rejectedLogRecords', metrics: 'rejectedDataPoints' }[signal];
  const partial = rejected || message ? { [field]: String(rejected), errorMessage: message } : {};
  if (json) return { partialSuccess: partial };
  const type = TYPES[signal].response;
  const payload = Object.keys(partial).length ? { partialSuccess: { [field]: rejected, errorMessage: message } } : {};
  return Buffer.from(type.encode(type.fromObject(payload)).finish());
}

/** Encode a request object (OTLP/JSON shape, ids as base64) to protobuf. Used by tests and the load tool. */
export function encodeRequest(signal, object) {
  const type = TYPES[signal].request;
  return Buffer.from(type.encode(type.fromObject(object)).finish());
}
