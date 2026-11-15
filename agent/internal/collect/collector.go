package collect

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// clockTicksPerSecond is USER_HZ, which is 100 on every Linux architecture.
const clockTicksPerSecond = 100

// fsUsage is what statfs reports for one filesystem.
type fsUsage struct {
	BlockSize               uint64
	Blocks, Bfree, Bavail   uint64
}

// Collector reads the system's counters and turns them into rates and percentages. It keeps the
// previous readings, so it must be used from one goroutine.
type Collector struct {
	ProcRoot string // normally /proc
	SysRoot  string // normally /sys
	EtcRoot  string // normally /etc

	now      func() time.Time
	statfs   func(path string) (fsUsage, error)
	pageSize uint64

	buf []byte // reused for every file read

	prevCPU     cpuTimes
	haveCPU     bool
	prevNet     map[string]netCounters
	prevNetAt   time.Time
	netScratch  []netCounters
	prevDisk    diskCounters
	prevDiskAt  time.Time
	haveDisk    bool
	prevProc    map[int]procPrev
	nextProc    map[int]procPrev
	prevProcAt  time.Time
	procScratch []procStat
}

type procPrev struct {
	Ticks     uint64
	StartTime uint64
}

// New returns a collector for the running system.
func New() *Collector {
	return &Collector{
		ProcRoot: "/proc",
		SysRoot:  "/sys",
		EtcRoot:  "/etc",
		now:      time.Now,
		statfs:   statfs,
		pageSize: uint64(os.Getpagesize()),
	}
}

// read returns the contents of a small file. The slice is only valid until the next read.
func (c *Collector) read(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if c.buf == nil {
		c.buf = make([]byte, 0, 8192)
	}
	buf := c.buf[:0]
	for {
		if len(buf) == cap(buf) {
			if cap(buf) >= 4<<20 {
				return nil, fmt.Errorf("%s is unexpectedly large", path)
			}
			buf = append(buf, 0)[:len(buf)]
		}
		n, err := f.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			break
		}
	}
	c.buf = buf
	return buf, nil
}

func (c *Collector) proc(name string) string { return filepath.Join(c.ProcRoot, name) }

// Prime takes the first reading of every counter, so that the first real sample has something
// to compare with.
func (c *Collector) Prime() {
	all := Enabled{CPU: true, DiskIO: true, Network: true}
	c.Sample(all, func(string, string) {})
	c.Processes(func(string, string) {})
}

// Sample takes one reading of the enabled collectors. Problems are passed to report and the
// affected values are simply left out; one failing collector never stops the others.
func (c *Collector) Sample(en Enabled, report Reporter) Sample {
	s := Sample{Time: c.now()}
	if en.CPU {
		c.sampleCPU(&s, report)
	}
	if en.Memory || en.Swap {
		c.sampleMemory(&s, en, report)
	}
	if en.Load {
		if data, err := c.read(c.proc("loadavg")); err != nil {
			report("collector_failed_load", describe("read the load average", err))
		} else if load, err := parseLoadavg(data); err != nil {
			report("collector_failed_load", "Could not understand /proc/loadavg.")
		} else {
			s.Load = load
		}
	}
	// Uptime is always sent: it is what tells the dashboard that a server rebooted.
	if data, err := c.read(c.proc("uptime")); err != nil {
		report("collector_failed_uptime", describe("read the uptime", err))
	} else if up, err := parseUptime(data); err != nil {
		report("collector_failed_uptime", "Could not understand /proc/uptime.")
	} else {
		s.Uptime = ptr(up)
	}
	if en.Disk {
		c.sampleDisk(&s, report)
	}
	if en.DiskIO {
		c.sampleDiskIO(&s, report)
	}
	if en.Network {
		c.sampleNetwork(&s, report)
	}
	return s
}

func describe(action string, err error) string {
	switch {
	case errors.Is(err, os.ErrPermission):
		return fmt.Sprintf("Could not %s: permission denied.", action)
	case errors.Is(err, os.ErrNotExist):
		return fmt.Sprintf("Could not %s: the file does not exist on this system.", action)
	}
	return truncate(fmt.Sprintf("Could not %s: %v", action, err), 300)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func (c *Collector) sampleCPU(s *Sample, report Reporter) {
	data, err := c.read(c.proc("stat"))
	if err != nil {
		report("collector_failed_cpu", describe("read CPU usage", err))
		return
	}
	cur, _, err := parseCPUStat(data)
	if err != nil {
		report("collector_failed_cpu", "Could not understand /proc/stat.")
		return
	}
	if c.haveCPU {
		if v, ok := cpuPercent(c.prevCPU, cur); ok {
			s.CPU = ptr(v)
		}
	}
	c.prevCPU, c.haveCPU = cur, true
}

func (c *Collector) sampleMemory(s *Sample, en Enabled, report Reporter) {
	data, err := c.read(c.proc("meminfo"))
	if err != nil {
		report("collector_failed_memory", describe("read memory usage", err))
		return
	}
	m, err := parseMeminfo(data)
	if err != nil {
		report("collector_failed_memory", "Could not understand /proc/meminfo.")
		return
	}
	if en.Memory {
		s.Memory = ptr(m.memoryPercent())
	}
	if en.Swap {
		s.Swap = ptr(m.swapPercent())
	}
}

func (c *Collector) sampleDisk(s *Sample, report Reporter) {
	data, err := c.read(c.proc("self/mountinfo"))
	if err != nil {
		report("collector_failed_disk", describe("list the mounted disks", err))
		return
	}
	entries := parseMountinfo(data)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	var denied, failed []string
	for _, e := range entries {
		if len(s.Mounts) >= MaxMounts {
			break
		}
		u, err := c.statfs(e.Path)
		if err != nil {
			if errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM) {
				denied = append(denied, e.Path)
			} else {
				failed = append(failed, e.Path)
			}
			continue
		}
		if u.Blocks == 0 {
			continue
		}
		used := u.Blocks - min(u.Bfree, u.Blocks)
		// The same formula as df: space reserved for root counts as unavailable.
		denominator := used + u.Bavail
		if denominator == 0 {
			continue
		}
		m := Mount{
			Path:       e.Path,
			Percent:    percent(100 * float64(used) / float64(denominator)),
			TotalBytes: clamp(float64(u.Blocks)*float64(u.BlockSize), 0, maxBytes),
			UsedBytes:  clamp(float64(used)*float64(u.BlockSize), 0, maxBytes),
		}
		s.Mounts = append(s.Mounts, m)
		if e.Path == "/" {
			s.Disk = ptr(m.Percent)
		}
	}
	if len(denied) > 0 {
		report("disk_permission", truncate("The agent is not allowed to read disk usage of "+strings.Join(denied, ", ")+
			". Allow the yuktiops user to enter the parent folders, or ignore this if you do not need that disk.", 300))
	}
	if len(failed) > 0 {
		report("collector_failed_disk", truncate("Could not read disk usage of "+strings.Join(failed, ", ")+".", 300))
	}
}

func (c *Collector) sampleDiskIO(s *Sample, report Reporter) {
	isDisk := wholeDiskByName
	if names, err := readDirNames(filepath.Join(c.SysRoot, "block")); err == nil && len(names) > 0 {
		whole := make(map[string]bool, len(names))
		for _, n := range names {
			whole[n] = true
		}
		isDisk = func(name string) bool { return whole[name] && !skipBlockDevice(name) }
	}
	data, err := c.read(c.proc("diskstats"))
	if err != nil {
		report("collector_failed_diskio", describe("read disk activity", err))
		return
	}
	cur, err := parseDiskstats(data, isDisk)
	if err != nil {
		// Containers and some virtual servers expose no block devices at all: not an error.
		if len(data) != 0 {
			report("collector_failed_diskio", "Could not understand /proc/diskstats.")
		}
		return
	}
	now := s.Time
	if c.haveDisk {
		if dt := now.Sub(c.prevDiskAt).Seconds(); dt > 0 && cur.Read >= c.prevDisk.Read && cur.Written >= c.prevDisk.Written {
			s.DiskRead = ptr(rate(cur.Read-c.prevDisk.Read, dt))
			s.DiskWrite = ptr(rate(cur.Written-c.prevDisk.Written, dt))
		}
	}
	c.prevDisk, c.prevDiskAt, c.haveDisk = cur, now, true
}

func rate(delta uint64, seconds float64) float64 {
	return float64(int64(clamp(float64(delta)/seconds, 0, maxRate) + 0.5))
}

func (c *Collector) sampleNetwork(s *Sample, report Reporter) {
	data, err := c.read(c.proc("net/dev"))
	if err != nil {
		report("collector_failed_network", describe("read network activity", err))
		return
	}
	cur, err := parseNetDev(data, c.netScratch)
	c.netScratch = cur
	if err != nil {
		report("collector_failed_network", "Could not understand /proc/net/dev.")
		return
	}
	now := s.Time
	dt := now.Sub(c.prevNetAt).Seconds()
	if c.prevNet != nil && dt > 0 {
		var rx, tx float64
		for _, n := range cur {
			p, ok := c.prevNet[n.Name]
			if !ok || n.Rx < p.Rx || n.Tx < p.Tx {
				continue // a new interface, or its counters were reset
			}
			r, t := rate(n.Rx-p.Rx, dt), rate(n.Tx-p.Tx, dt)
			rx += r
			tx += t
			if len(s.Interfaces) < MaxInterfaces {
				s.Interfaces = append(s.Interfaces, Interface{Name: n.Name, RxBps: r, TxBps: t})
			}
		}
		s.NetRx = ptr(clamp(rx, 0, maxRate))
		s.NetTx = ptr(clamp(tx, 0, maxRate))
	}
	if c.prevNet == nil {
		c.prevNet = make(map[string]netCounters, len(cur))
	}
	clear(c.prevNet)
	for _, n := range cur {
		c.prevNet[n.Name] = n
	}
	c.prevNetAt = now
}

func readDirNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.Readdirnames(-1)
}

// Processes returns the ten busiest processes since the previous call (CPU first, then memory).
// It is called once per data point rather than once per sample, because walking /proc is the
// most expensive thing the agent does.
func (c *Collector) Processes(report Reporter) []Process {
	names, err := readDirNames(c.ProcRoot)
	if err != nil {
		report("collector_failed_processes", describe("list the running processes", err))
		return nil
	}
	now := c.now()
	stats := c.procScratch[:0]
	for _, name := range names {
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		data, err := c.read(filepath.Join(c.ProcRoot, name, "stat"))
		if err != nil {
			continue // the process exited between listing and reading
		}
		p, err := parseProcStat(data)
		if err != nil {
			continue
		}
		stats = append(stats, p)
	}
	c.procScratch = stats
	if len(stats) <= 1 && c.ProcRoot == "/proc" {
		report("processes_restricted", "The agent can only see its own process. /proc is probably mounted with hidepid; "+
			"add the yuktiops user to the group allowed to see all processes, or switch off the process list.")
	}

	if c.nextProc == nil {
		c.nextProc = make(map[int]procPrev, len(stats))
	}
	clear(c.nextProc)
	dt := now.Sub(c.prevProcAt).Seconds()
	havePrev := c.prevProc != nil && dt > 0
	type ranked struct {
		index int
		cpu   float64
	}
	list := make([]ranked, 0, len(stats))
	for i, p := range stats {
		c.nextProc[p.PID] = procPrev{Ticks: p.Ticks, StartTime: p.StartTime}
		cpu := 0.0
		if havePrev {
			if prev, ok := c.prevProc[p.PID]; ok && prev.StartTime == p.StartTime && p.Ticks >= prev.Ticks {
				cpu = 100 * float64(p.Ticks-prev.Ticks) / clockTicksPerSecond / dt
			}
		}
		list = append(list, ranked{index: i, cpu: cpu})
	}
	c.prevProc, c.nextProc = c.nextProc, c.prevProc
	c.prevProcAt = now

	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.cpu != b.cpu {
			return a.cpu > b.cpu
		}
		ra, rb := stats[a.index].RSSPages, stats[b.index].RSSPages
		if ra != rb {
			return ra > rb
		}
		return stats[a.index].PID < stats[b.index].PID
	})
	if len(list) > TopProcesses {
		list = list[:TopProcesses]
	}
	out := make([]Process, 0, len(list))
	for _, r := range list {
		p := stats[r.index]
		out = append(out, Process{
			Name:     truncate(strings.ToValidUTF8(string(p.Name[:p.NameLen]), "?"), maxProcNameLen),
			PID:      p.PID,
			CPU:      round2(clamp(r.cpu, 0, maxProcCPU)),
			MemBytes: clamp(float64(p.RSSPages)*float64(c.pageSize), 0, maxBytes),
		})
	}
	return out
}

// HostInfo describes the machine for the "agent" part of a payload.
type HostInfo struct {
	OS       string
	Cores    int
	RAMBytes float64
}

// Host reads the facts about the machine that rarely change.
func (c *Collector) Host() HostInfo {
	var h HostInfo
	if data, err := c.read(filepath.Join(c.EtcRoot, "os-release")); err == nil {
		h.OS = parseOSRelease(data)
	}
	if h.OS == "" {
		h.OS = "Linux"
	}
	if data, err := c.read(c.proc("stat")); err == nil {
		if _, cores, err := parseCPUStat(data); err == nil && cores > 0 {
			h.Cores = min(cores, 4096)
		}
	}
	if data, err := c.read(c.proc("meminfo")); err == nil {
		if m, err := parseMeminfo(data); err == nil {
			h.RAMBytes = clamp(float64(m.Total), 0, maxBytes)
		}
	}
	return h
}
