// Package prom collects Prometheus metrics (node_exporter and cAdvisor names, plus database
// exporters' names) and sends them with Prometheus remote_write v1 to the agent's API.
//
// It only runs when the remote settings switch on collectors.prometheus, which the backend does
// for plans that include advanced metrics. Everything is read-only: the node collectors read
// /proc and /sys under the agent's host root, container metrics come from the Docker socket and
// database metrics from read-only queries.
package prom

import (
	"math"
	"sort"
	"strconv"

	"github.com/golang/snappy"
	dto "github.com/prometheus/client_model/go"
	"google.golang.org/protobuf/encoding/protowire"
)

// Label is one name="value" pair.
type Label struct {
	Name, Value string
}

// Series is one time series with its samples (remote_write TimeSeries).
type Series struct {
	Labels []Label // sorted by name, including __name__
	Value  float64
	TimeMs int64
}

// Remote write v1 field numbers (prometheus/prompb).
const (
	fieldTimeseries  = 1 // WriteRequest.timeseries
	fieldLabels      = 1 // TimeSeries.labels
	fieldSamples     = 2 // TimeSeries.samples
	fieldLabelName   = 1
	fieldLabelValue  = 2
	fieldSampleValue = 1
	fieldSampleTime  = 2
)

// EncodeWriteRequest encodes series as a prompb.WriteRequest (protobuf, uncompressed).
func EncodeWriteRequest(series []Series) []byte {
	var out, ts, sub []byte
	for _, s := range series {
		ts = ts[:0]
		for _, l := range s.Labels {
			sub = sub[:0]
			sub = protowire.AppendTag(sub, fieldLabelName, protowire.BytesType)
			sub = protowire.AppendString(sub, l.Name)
			sub = protowire.AppendTag(sub, fieldLabelValue, protowire.BytesType)
			sub = protowire.AppendString(sub, l.Value)
			ts = protowire.AppendTag(ts, fieldLabels, protowire.BytesType)
			ts = protowire.AppendBytes(ts, sub)
		}
		sub = sub[:0]
		sub = protowire.AppendTag(sub, fieldSampleValue, protowire.Fixed64Type)
		sub = protowire.AppendFixed64(sub, math.Float64bits(s.Value))
		sub = protowire.AppendTag(sub, fieldSampleTime, protowire.VarintType)
		sub = protowire.AppendVarint(sub, uint64(s.TimeMs))
		ts = protowire.AppendTag(ts, fieldSamples, protowire.BytesType)
		ts = protowire.AppendBytes(ts, sub)

		out = protowire.AppendTag(out, fieldTimeseries, protowire.BytesType)
		out = protowire.AppendBytes(out, ts)
	}
	return out
}

// Compress applies snappy block compression, as remote_write requires.
func Compress(raw []byte) []byte { return snappy.Encode(nil, raw) }

// newSeries builds a series from a metric name, its own labels and the labels the agent adds.
// Agent labels win over the metric's own labels with the same name. Labels with an empty value
// are dropped (Prometheus treats them as absent).
func newSeries(name string, own []Label, extra []Label, value float64, ms int64) Series {
	labels := make([]Label, 0, len(own)+len(extra)+1)
	labels = append(labels, Label{"__name__", name})
	seen := map[string]bool{"__name__": true}
	for _, l := range extra {
		if !seen[l.Name] && l.Value != "" {
			seen[l.Name] = true
			labels = append(labels, l)
		}
	}
	for _, l := range own {
		if !seen[l.Name] && l.Value != "" {
			seen[l.Name] = true
			labels = append(labels, l)
		}
	}
	sort.Slice(labels, func(i, j int) bool { return labels[i].Name < labels[j].Name })
	return Series{Labels: labels, Value: value, TimeMs: ms}
}

// FamiliesToSeries flattens gathered metric families into series (summaries and histograms are
// expanded into _sum, _count, quantile and _bucket series, as Prometheus does).
func FamiliesToSeries(families []*dto.MetricFamily, extra []Label, ms int64) []Series {
	var out []Series
	for _, mf := range families {
		name := mf.GetName()
		for _, m := range mf.GetMetric() {
			own := make([]Label, 0, len(m.GetLabel()))
			for _, lp := range m.GetLabel() {
				own = append(own, Label{lp.GetName(), lp.GetValue()})
			}
			t := ms
			if m.TimestampMs != nil {
				t = m.GetTimestampMs()
			}
			switch mf.GetType() {
			case dto.MetricType_COUNTER:
				out = append(out, newSeries(name, own, extra, m.GetCounter().GetValue(), t))
			case dto.MetricType_GAUGE:
				out = append(out, newSeries(name, own, extra, m.GetGauge().GetValue(), t))
			case dto.MetricType_UNTYPED:
				out = append(out, newSeries(name, own, extra, m.GetUntyped().GetValue(), t))
			case dto.MetricType_SUMMARY:
				s := m.GetSummary()
				out = append(out, newSeries(name+"_sum", own, extra, s.GetSampleSum(), t))
				out = append(out, newSeries(name+"_count", own, extra, float64(s.GetSampleCount()), t))
				for _, q := range s.GetQuantile() {
					ql := append(append([]Label(nil), own...), Label{"quantile", formatFloat(q.GetQuantile())})
					out = append(out, newSeries(name, ql, extra, q.GetValue(), t))
				}
			case dto.MetricType_HISTOGRAM, dto.MetricType_GAUGE_HISTOGRAM:
				h := m.GetHistogram()
				out = append(out, newSeries(name+"_sum", own, extra, h.GetSampleSum(), t))
				out = append(out, newSeries(name+"_count", own, extra, float64(h.GetSampleCount()), t))
				inf := false
				for _, b := range h.GetBucket() {
					if math.IsInf(b.GetUpperBound(), 1) {
						inf = true
					}
					bl := append(append([]Label(nil), own...), Label{"le", formatFloat(b.GetUpperBound())})
					out = append(out, newSeries(name+"_bucket", bl, extra, float64(b.GetCumulativeCount()), t))
				}
				if !inf {
					bl := append(append([]Label(nil), own...), Label{"le", "+Inf"})
					out = append(out, newSeries(name+"_bucket", bl, extra, float64(h.GetSampleCount()), t))
				}
			}
		}
	}
	return out
}

func formatFloat(f float64) string {
	if math.IsInf(f, 1) {
		return "+Inf"
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}
