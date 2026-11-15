package collect

// Aggregate turns the samples taken during one send interval into a single data point:
// percentages and rates are averaged, everything else is taken from the newest sample.
func Aggregate(samples []Sample, processes []Process) Point {
	last := samples[len(samples)-1]
	p := Point{
		Time:          FormatTime(last.Time),
		CPU:           average(samples, func(s *Sample) *float64 { return s.CPU }, true),
		Memory:        average(samples, func(s *Sample) *float64 { return s.Memory }, true),
		Swap:          average(samples, func(s *Sample) *float64 { return s.Swap }, true),
		Disk:          average(samples, func(s *Sample) *float64 { return s.Disk }, true),
		NetRxBps:      average(samples, func(s *Sample) *float64 { return s.NetRx }, false),
		NetTxBps:      average(samples, func(s *Sample) *float64 { return s.NetTx }, false),
		DiskReadBps:   average(samples, func(s *Sample) *float64 { return s.DiskRead }, false),
		DiskWriteBps:  average(samples, func(s *Sample) *float64 { return s.DiskWrite }, false),
		Load:          last.Load,
		UptimeSeconds: last.Uptime,
	}
	details := Details{
		Mounts:     last.Mounts,
		Interfaces: averageInterfaces(samples),
		Processes:  processes,
	}
	if len(details.Mounts)+len(details.Interfaces)+len(details.Processes) > 0 {
		p.Details = &details
	}
	return p
}

func average(samples []Sample, get func(*Sample) *float64, isPercent bool) *float64 {
	sum, n := 0.0, 0
	for i := range samples {
		if v := get(&samples[i]); v != nil {
			sum += *v
			n++
		}
	}
	if n == 0 {
		return nil
	}
	mean := sum / float64(n)
	if isPercent {
		return ptr(percent(mean))
	}
	return ptr(float64(int64(clamp(mean, 0, maxRate) + 0.5)))
}

// averageInterfaces averages each interface's rates over the samples in which it appears,
// keeping the order of the newest sample.
func averageInterfaces(samples []Sample) []Interface {
	last := samples[len(samples)-1].Interfaces
	if len(last) == 0 {
		return nil
	}
	out := make([]Interface, 0, len(last))
	for _, iface := range last {
		var rx, tx float64
		n := 0
		for i := range samples {
			for _, other := range samples[i].Interfaces {
				if other.Name == iface.Name {
					rx += other.RxBps
					tx += other.TxBps
					n++
					break
				}
			}
		}
		out = append(out, Interface{
			Name:  iface.Name,
			RxBps: float64(int64(rx/float64(n) + 0.5)),
			TxBps: float64(int64(tx/float64(n) + 0.5)),
		})
	}
	return out
}
