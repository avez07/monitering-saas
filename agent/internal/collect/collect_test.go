package collect

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "host", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestParseCPUStat(t *testing.T) {
	times, cores, err := parseCPUStat(fixture(t, "proc/stat"))
	if err != nil {
		t.Fatal(err)
	}
	if times.Total != 95500 || times.Busy != 14000 || cores != 4 {
		t.Errorf("got %+v cores=%d, want total 95500 busy 14000 cores 4", times, cores)
	}
	// 1000 more ticks, 250 of them busy (iowait counts as idle): 25 %.
	next := cpuTimes{Total: times.Total + 1000, Busy: times.Busy + 250}
	if got, ok := cpuPercent(times, next); !ok || got != 25 {
		t.Errorf("cpuPercent = %v, %v; want 25", got, ok)
	}
	if _, ok := cpuPercent(times, times); ok {
		t.Error("no elapsed ticks must not produce a value")
	}
	if _, ok := cpuPercent(next, times); ok {
		t.Error("counters going backwards must not produce a value")
	}
	// Old kernels have only four columns.
	old, _, err := parseCPUStat([]byte("cpu 100 0 50 850\ncpu0 100 0 50 850\n"))
	if err != nil || old.Total != 1000 || old.Busy != 150 {
		t.Errorf("4-column cpu line: %+v, %v", old, err)
	}
	for _, bad := range []string{"", "intr 1 2 3\n", "cpu a b c d\n", "cpu 1 2\n"} {
		if _, _, err := parseCPUStat([]byte(bad)); err == nil {
			t.Errorf("parseCPUStat(%q) should fail", bad)
		}
	}
}

func TestParseMeminfo(t *testing.T) {
	m, err := parseMeminfo(fixture(t, "proc/meminfo"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Total != 8000000*1024 || m.Available != 6000000*1024 {
		t.Errorf("got %+v", m)
	}
	if got := m.memoryPercent(); got != 25 {
		t.Errorf("memory = %v, want 25", got)
	}
	if got := m.swapPercent(); got != 25 {
		t.Errorf("swap = %v, want 25", got)
	}
	// No MemAvailable (old kernel): free + buffers + cached + reclaimable.
	old, err := parseMeminfo([]byte("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\nSReclaimable: 50 kB\n"))
	if err != nil || old.memoryPercent() != 60 {
		t.Errorf("fallback estimate: %+v %v, memory %v, want 60", old, err, old.memoryPercent())
	}
	// No swap configured is 0 %, not a division by zero.
	if old.swapPercent() != 0 {
		t.Errorf("swap without a swap device = %v, want 0", old.swapPercent())
	}
	if _, err := parseMeminfo([]byte("Nothing: 1 kB\n")); err == nil {
		t.Error("meminfo without MemTotal should fail")
	}
}

func TestParseLoadAndUptime(t *testing.T) {
	load, err := parseLoadavg(fixture(t, "proc/loadavg"))
	if err != nil || !reflect.DeepEqual(load, []float64{0.52, 1.25, 2}) {
		t.Errorf("load = %v, %v", load, err)
	}
	if _, err := parseLoadavg([]byte("0.5 x")); err == nil {
		t.Error("bad loadavg should fail")
	}
	up, err := parseUptime(fixture(t, "proc/uptime"))
	if err != nil || up != 86400 {
		t.Errorf("uptime = %v, %v", up, err)
	}
	if _, err := parseUptime([]byte("")); err == nil {
		t.Error("empty uptime should fail")
	}
}

func TestParseNetDev(t *testing.T) {
	got, err := parseNetDev(fixture(t, "proc/net/dev"), nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []netCounters{
		{Name: "eth0", Rx: 1000000, Tx: 500000},
		{Name: "ens10", Rx: 2000000, Tx: 300000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v (loopback, docker, veth and bridges are skipped)", got, want)
	}
	if _, err := parseNetDev([]byte(""), nil); err == nil {
		t.Error("empty /proc/net/dev should fail")
	}
}

func TestParseDiskstats(t *testing.T) {
	data := fixture(t, "proc/diskstats")
	whole := map[string]bool{"sda": true, "nvme0n1": true, "loop0": true, "dm-0": true}
	got, err := parseDiskstats(data, func(n string) bool { return whole[n] && !skipBlockDevice(n) })
	if err != nil {
		t.Fatal(err)
	}
	want := diskCounters{Read: 600000 * 512, Written: 1400000 * 512}
	if got != want {
		t.Errorf("got %+v, want %+v (partitions, loop and dm devices must not be counted)", got, want)
	}
	// Without /sys/block the name-based rule must give the same answer.
	byName, err := parseDiskstats(data, wholeDiskByName)
	if err != nil || byName != want {
		t.Errorf("name-based: %+v, %v", byName, err)
	}
	if _, err := parseDiskstats([]byte(""), wholeDiskByName); err == nil {
		t.Error("empty diskstats should report an error")
	}
}

func TestWholeDiskByName(t *testing.T) {
	disks := []string{"sda", "sdz", "vda", "xvda", "hda", "nvme0n1", "nvme10n2", "mmcblk0"}
	parts := []string{"sda1", "sda12", "vda1", "xvda2", "hda3", "nvme0n1p1", "nvme10n2p14", "mmcblk0p2", "loop0", "ram1", "zram0", "dm-3", "md0", "sr0"}
	for _, n := range disks {
		if !wholeDiskByName(n) {
			t.Errorf("%s should count as a whole disk", n)
		}
	}
	for _, n := range parts {
		if wholeDiskByName(n) {
			t.Errorf("%s should not count as a whole disk", n)
		}
	}
}

func TestParseMountinfo(t *testing.T) {
	entries := parseMountinfo(fixture(t, "proc/self/mountinfo"))
	var paths []string
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	// Pseudo filesystems, NFS, Docker overlays and snaps are skipped; bind mounts of the same
	// device (systemd's private /tmp and state directory, /mnt/backups) collapse to one entry.
	want := []string{"/", "/boot", "/data", "/mnt/My Disk", "/root/secret"}
	if !reflect.DeepEqual(paths, want) {
		t.Errorf("mounts = %q, want %q", paths, want)
	}
	if entries[0].FSType != "ext4" || entries[2].FSType != "xfs" || entries[2].Device != "259:1" {
		t.Errorf("entries = %+v", entries)
	}
	// In a container the root filesystem is an overlay and must be kept.
	docker := parseMountinfo([]byte("500 400 0:60 / / rw,relatime - overlay overlay rw\n" +
		"501 500 0:61 / /proc rw - proc proc rw\n" +
		"502 500 8:1 /var/lib/docker/containers/x/hosts /etc/hosts rw - ext4 /dev/sda1 rw\n"))
	if len(docker) != 1 || docker[0].Path != "/" {
		t.Errorf("container mounts = %+v", docker)
	}
}

func TestParseProcStat(t *testing.T) {
	p, err := parseProcStat(fixture(t, "proc/4242/stat"))
	if err != nil {
		t.Fatal(err)
	}
	if p.PID != 4242 || string(p.Name[:p.NameLen]) != "my (weird) app" || p.Ticks != 12000 || p.StartTime != 7000000 || p.RSSPages != 250000 {
		t.Errorf("got %+v name=%q", p, p.Name[:p.NameLen])
	}
	p, err = parseProcStat(fixture(t, "proc/812/stat"))
	if err != nil || string(p.Name[:p.NameLen]) != "nginx: worker pr" || p.Ticks != 5000 || p.RSSPages != 5000 {
		t.Errorf("nginx: %+v name=%q err=%v", p, p.Name[:p.NameLen], err)
	}
	for _, bad := range []string{"", "12 no parens", "x (name) S 1 2", "12 (short) S 1 2 3"} {
		if _, err := parseProcStat([]byte(bad)); err == nil {
			t.Errorf("parseProcStat(%q) should fail", bad)
		}
	}
}

func TestParseOSRelease(t *testing.T) {
	if got := parseOSRelease(fixture(t, "etc/os-release")); got != "Ubuntu 24.04.1 LTS" {
		t.Errorf("got %q", got)
	}
	if got := parseOSRelease([]byte("NAME=Alpine\nVERSION='3.21'\n")); got != "Alpine 3.21" {
		t.Errorf("got %q", got)
	}
	if got := parseOSRelease([]byte("PRETTY_NAME=\"" + strings.Repeat("x", 300) + "\"\n")); len(got) != 100 {
		t.Errorf("os name must be cut to 100 characters, got %d", len(got))
	}
}

// copyTree copies the fixture host into a temporary directory so a test can change the counters.
func copyTree(t *testing.T) string {
	t.Helper()
	src := filepath.Join("testdata", "host")
	dst := t.TempDir()
	err := filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if info.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func write(t *testing.T, root, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

type errorLog map[string]string

func (e errorLog) report(code, message string) { e[code] = message }

var allOn = Enabled{CPU: true, Memory: true, Swap: true, Disk: true, DiskIO: true, Network: true, Load: true}

func testCollector(t *testing.T) (*Collector, string, *time.Time) {
	root := copyTree(t)
	now := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	c := New()
	c.ProcRoot = filepath.Join(root, "proc")
	c.SysRoot = filepath.Join(root, "sys")
	c.EtcRoot = filepath.Join(root, "etc")
	c.pageSize = 4096
	c.now = func() time.Time { return now }
	c.statfs = func(path string) (fsUsage, error) {
		switch path {
		case "/":
			// 100 GiB disk, 60 GiB used, 5 GiB reserved for root: df shows 60/(60+35) = 63.16 %.
			return fsUsage{BlockSize: 4096, Blocks: 26214400, Bfree: 10485760, Bavail: 9175040}, nil
		case "/boot":
			return fsUsage{BlockSize: 4096, Blocks: 250000, Bfree: 200000, Bavail: 200000}, nil
		case "/data":
			return fsUsage{BlockSize: 4096, Blocks: 1000000, Bfree: 100000, Bavail: 100000}, nil
		case "/mnt/My Disk":
			return fsUsage{}, syscall.EIO
		case "/root/secret":
			return fsUsage{}, syscall.EACCES
		}
		return fsUsage{}, errors.New("unexpected path " + path)
	}
	return c, root, &now
}

func TestCollectorSampleAndRates(t *testing.T) {
	c, root, now := testCollector(t)
	errs := errorLog{}
	c.Prime()

	// Ten seconds later the network and disk counters have advanced.
	*now = now.Add(10 * time.Second)
	write(t, root, "proc/stat", "cpu  10200 500 3100 80550 1550 0 50 50 0 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\n")
	write(t, root, "proc/net/dev", "h1\nh2\n"+
		"    lo: 9999999 1 0 0 0 0 0 0 9999999 1 0 0 0 0 0 0\n"+
		"  eth0: 1100000 1 0 0 0 0 0 0 520000 1 0 0 0 0 0 0\n"+ // +100000 rx, +20000 tx
		" ens10: 2050000 1 0 0 0 0 0 0 300000 1 0 0 0 0 0 0\n"+ // +50000 rx
		"  eth9: 5000000 1 0 0 0 0 0 0 5000000 1 0 0 0 0 0 0\n") // appeared just now: no rate yet
	write(t, root, "proc/diskstats",
		"   8 0 sda 5000 100 402000 3000 8000 200 804000 9000 0 5000 12000\n"+ // +2000 read, +4000 written sectors
			"   8 1 sda1 4000 80 302000 2500 7000 150 704000 8000 0 4500 10500\n"+
			" 259 0 nvme0n1 2000 0 200000 1000 3000 0 600000 2000 0 1500 3000\n"+
			" 253 0 dm-0 6000 0 999999 3500 9000 0 999999 9500 0 5200 13000\n")
	s := c.Sample(allOn, errs.report)

	check := func(name string, got *float64, want float64) {
		t.Helper()
		if got == nil || *got != want {
			t.Errorf("%s = %v, want %v", name, deref(got), want)
		}
	}
	// In this reading the total grew by 500 ticks but idle+iowait grew by 600, so "busy" went
	// backwards (14000 -> 13900). The collector must give no value rather than a negative one.
	if s.CPU != nil {
		t.Errorf("cpu = %v, want no value when the busy counter went backwards", *s.CPU)
	}
	check("memory", s.Memory, 25)
	check("swap", s.Swap, 25)
	check("uptime", s.Uptime, 86400)
	check("netRx", s.NetRx, 15000)          // (100000 + 50000) / 10 s
	check("netTx", s.NetTx, 2000)           // 20000 / 10 s
	check("diskRead", s.DiskRead, 102400)   // 2000 sectors * 512 / 10 s
	check("diskWrite", s.DiskWrite, 204800) // 4000 sectors * 512 / 10 s
	check("disk", s.Disk, 63.16)
	if !reflect.DeepEqual(s.Load, []float64{0.52, 1.25, 2}) {
		t.Errorf("load = %v", s.Load)
	}
	wantIfaces := []Interface{{Name: "eth0", RxBps: 10000, TxBps: 2000}, {Name: "ens10", RxBps: 5000, TxBps: 0}}
	if !reflect.DeepEqual(s.Interfaces, wantIfaces) {
		t.Errorf("interfaces = %+v, want %+v", s.Interfaces, wantIfaces)
	}
	wantMounts := []Mount{
		{Path: "/", Percent: 63.16, TotalBytes: 26214400 * 4096, UsedBytes: 15728640 * 4096},
		{Path: "/boot", Percent: 20, TotalBytes: 250000 * 4096, UsedBytes: 50000 * 4096},
		{Path: "/data", Percent: 90, TotalBytes: 1000000 * 4096, UsedBytes: 900000 * 4096},
	}
	if !reflect.DeepEqual(s.Mounts, wantMounts) {
		t.Errorf("mounts = %+v\nwant %+v", s.Mounts, wantMounts)
	}
	// The unreadable mounts are reported in plain language with stable codes.
	if msg := errs["disk_permission"]; !strings.Contains(msg, "/root/secret") {
		t.Errorf("disk_permission = %q", msg)
	}
	if msg := errs["collector_failed_disk"]; !strings.Contains(msg, "/mnt/My Disk") {
		t.Errorf("collector_failed_disk = %q", msg)
	}
	if len(errs) != 2 {
		t.Errorf("unexpected errors: %v", errs)
	}

	// A normal CPU step: +1000 ticks, 300 of them busy.
	*now = now.Add(10 * time.Second)
	write(t, root, "proc/stat", "cpu  10500 500 3100 81250 1550 0 50 50 0 0\n")
	s = c.Sample(allOn, errs.report)
	check("cpu", s.CPU, 30)
	check("netRx (no traffic)", s.NetRx, 0)
}

func deref(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func TestCollectorSwitchesAndFailures(t *testing.T) {
	c, root, now := testCollector(t)
	c.Prime()
	*now = now.Add(10 * time.Second)

	// Everything switched off: only the time and uptime remain, and nothing is read or reported.
	errs := errorLog{}
	s := c.Sample(Enabled{}, errs.report)
	if s.CPU != nil || s.Memory != nil || s.Swap != nil || s.Disk != nil || s.Load != nil ||
		s.NetRx != nil || s.DiskRead != nil || s.Mounts != nil || s.Interfaces != nil {
		t.Errorf("disabled collectors still produced values: %+v", s)
	}
	if s.Uptime == nil || len(errs) != 0 {
		t.Errorf("uptime = %v, errors = %v", s.Uptime, errs)
	}

	// Broken and missing files produce error codes that the backend accepts, never a panic.
	write(t, root, "proc/stat", "garbage\n")
	write(t, root, "proc/meminfo", "garbage\n")
	write(t, root, "proc/loadavg", "garbage\n")
	write(t, root, "proc/net/dev", "")
	os.Remove(filepath.Join(root, "proc/uptime"))
	os.Remove(filepath.Join(root, "proc/self/mountinfo"))
	write(t, root, "proc/diskstats", "garbage\n")
	s = c.Sample(allOn, errs.report)
	code := regexp.MustCompile(`^[a-z0-9_]{1,60}$`)
	for _, want := range []string{"collector_failed_cpu", "collector_failed_memory", "collector_failed_load",
		"collector_failed_network", "collector_failed_uptime", "collector_failed_disk", "collector_failed_diskio"} {
		if _, ok := errs[want]; !ok {
			t.Errorf("missing error %s (have %v)", want, errs)
		}
	}
	for c, msg := range errs {
		if !code.MatchString(c) || len(msg) == 0 || len(msg) > 300 {
			t.Errorf("error %q / %q does not fit the ingest schema", c, msg)
		}
	}
	if s.CPU != nil || s.Memory != nil || s.Uptime != nil {
		t.Errorf("failed collectors must leave their values out: %+v", s)
	}
}

func TestProcesses(t *testing.T) {
	c, root, now := testCollector(t)
	errs := errorLog{}
	first := c.Processes(errs.report)
	// First scan: no CPU history yet, so the list is ordered by memory.
	if len(first) != 4 || first[0].PID != 4242 || first[0].CPU != 0 || first[0].MemBytes != 250000*4096 {
		t.Fatalf("first scan = %+v", first)
	}
	if first[0].Name != "my (weird) app" {
		t.Errorf("name = %q", first[0].Name)
	}

	// 30 seconds later nginx used 6 s of CPU (600 ticks = 20 % of a core) and pid 4242 was
	// replaced by a new process with the same pid (different start time): its CPU must be 0.
	*now = now.Add(30 * time.Second)
	write(t, root, "proc/812/stat", "812 (nginx: worker process) S 800 800 800 0 -1 4194624 9000 0 3 0 4500 1100 0 0 20 0 1 0 2000 90000000 5000 0\n")
	write(t, root, "proc/4242/stat", "4242 (reborn) R 1 4242 4242 0 -1 4194304 100 0 0 0 99000 3000 0 0 20 0 8 0 9999999 800000000 100 0\n")
	second := c.Processes(errs.report)
	if second[0].PID != 812 || second[0].CPU != 20 || second[0].Name != "nginx: worker pr" {
		t.Errorf("busiest = %+v, want nginx at 20%%", second[0])
	}
	for _, p := range second {
		if p.PID == 4242 && p.CPU != 0 {
			t.Errorf("a recycled pid must not inherit the old process's CPU time: %+v", p)
		}
	}
	if len(errs) != 0 {
		t.Errorf("unexpected errors: %v", errs)
	}

	// Never more than ten, whatever is running.
	for pid := 5000; pid < 5030; pid++ {
		dir := filepath.Join(root, "proc", itoa(pid))
		os.MkdirAll(dir, 0o755)
		write(t, root, filepath.Join("proc", itoa(pid), "stat"), itoa(pid)+" (worker) S 1 1 1 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 100 0 10 0\n")
	}
	if got := c.Processes(errs.report); len(got) != TopProcesses {
		t.Errorf("got %d processes, want %d", len(got), TopProcesses)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestHost(t *testing.T) {
	c, _, _ := testCollector(t)
	h := c.Host()
	if h.OS != "Ubuntu 24.04.1 LTS" || h.Cores != 4 || h.RAMBytes != 8000000*1024 {
		t.Errorf("host = %+v", h)
	}
}

func TestAggregateMatchesIngestSchema(t *testing.T) {
	t0 := time.Date(2026, 11, 14, 10, 0, 0, 123456789, time.FixedZone("IST", 5*3600+1800))
	samples := []Sample{
		{Time: t0, CPU: ptr(10), Memory: ptr(40), Swap: ptr(0), Disk: ptr(63.16), NetRx: ptr(1000), NetTx: ptr(100),
			DiskRead: ptr(0), DiskWrite: ptr(300), Interfaces: []Interface{{Name: "eth0", RxBps: 1000, TxBps: 100}}},
		{Time: t0.Add(10 * time.Second), Memory: ptr(41), Swap: ptr(0), Disk: ptr(63.16), NetRx: ptr(2000), NetTx: ptr(200),
			DiskRead: ptr(0), DiskWrite: ptr(301), Interfaces: []Interface{{Name: "eth0", RxBps: 2000, TxBps: 200}}},
		{Time: t0.Add(20 * time.Second), CPU: ptr(20.555), Memory: ptr(42), Swap: ptr(0), Disk: ptr(63.18), NetRx: ptr(3000), NetTx: ptr(300),
			DiskRead: ptr(0), DiskWrite: ptr(302), Uptime: ptr(86420), Load: []float64{0.5, 0.6, 0.7},
			Mounts:     []Mount{{Path: "/", Percent: 63.18, TotalBytes: 1e11, UsedBytes: 6e10}},
			Interfaces: []Interface{{Name: "eth0", RxBps: 3000, TxBps: 300}, {Name: "eth1", RxBps: 7, TxBps: 9}}},
	}
	procs := []Process{{Name: "nginx", PID: 812, CPU: 20, MemBytes: 2048}}
	p := Aggregate(samples, procs)
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"time":"2026-11-14T04:30:20.123Z","cpu":15.28,"memory":41,"swap":0,"disk":63.17,"load":[0.5,0.6,0.7],` +
		`"netRxBps":2000,"netTxBps":200,"diskReadBps":0,"diskWriteBps":301,"uptimeSeconds":86420,` +
		`"details":{"mounts":[{"path":"/","percent":63.18,"totalBytes":100000000000,"usedBytes":60000000000}],` +
		`"interfaces":[{"name":"eth0","rxBps":2000,"txBps":200},{"name":"eth1","rxBps":7,"txBps":9}],` +
		`"processes":[{"name":"nginx","pid":812,"cpu":20,"memBytes":2048}]}}`
	if string(data) != want {
		t.Errorf("payload mismatch\n got %s\nwant %s", data, want)
	}

	// A point with every collector off still has a time and nothing else that could fail validation.
	empty, _ := json.Marshal(Aggregate([]Sample{{Time: t0}}, nil))
	if string(empty) != `{"time":"2026-11-14T04:30:00.123Z"}` {
		t.Errorf("empty point = %s", empty)
	}
}
