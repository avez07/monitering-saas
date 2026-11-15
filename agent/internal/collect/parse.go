package collect

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
)

// This file holds the pure parsers for /proc files. They take the file contents and return
// plain values, which keeps them easy to test against fixture data.

var errFormat = errors.New("unexpected format")

func parseUint(b []byte) (uint64, error) {
	if len(b) == 0 {
		return 0, errFormat
	}
	var n uint64
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, errFormat
		}
		d := uint64(c - '0')
		if n > (1<<64-1-d)/10 {
			return 0, errFormat
		}
		n = n*10 + d
	}
	return n, nil
}

// nextLine returns the first line of data and the rest.
func nextLine(data []byte) (line, rest []byte) {
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return data[:i], data[i+1:]
	}
	return data, nil
}

// nextField returns the next whitespace-separated field and the rest.
func nextField(line []byte) (field, rest []byte) {
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	j := i
	for j < len(line) && line[j] != ' ' && line[j] != '\t' {
		j++
	}
	return line[i:j], line[j:]
}

// cpuTimes are the totals from the first line of /proc/stat, in clock ticks.
type cpuTimes struct {
	Busy  uint64
	Total uint64
}

// parseCPUStat reads the aggregate "cpu" line and counts the per-CPU lines (the number of cores).
func parseCPUStat(data []byte) (times cpuTimes, cores int, err error) {
	found := false
	for len(data) > 0 {
		var line []byte
		line, data = nextLine(data)
		if !bytes.HasPrefix(line, []byte("cpu")) {
			continue
		}
		name, rest := nextField(line)
		if len(name) > 3 {
			if _, err := parseUint(name[3:]); err == nil {
				cores++
			}
			continue
		}
		// user nice system idle iowait irq softirq steal [guest guest_nice]
		// guest time is already included in user, so only the first eight are summed.
		var v [8]uint64
		n := 0
		for n < len(v) {
			var f []byte
			f, rest = nextField(rest)
			if len(f) == 0 {
				break
			}
			x, err := parseUint(f)
			if err != nil {
				return cpuTimes{}, 0, errFormat
			}
			v[n] = x
			n++
		}
		if n < 4 {
			return cpuTimes{}, 0, errFormat
		}
		var total uint64
		for _, x := range v {
			total += x
		}
		idle := v[3] + v[4] // idle + iowait
		times = cpuTimes{Busy: total - idle, Total: total}
		found = true
	}
	if !found {
		return cpuTimes{}, 0, errFormat
	}
	return times, cores, nil
}

// cpuPercent is the share of non-idle time between two readings.
func cpuPercent(prev, cur cpuTimes) (float64, bool) {
	if cur.Total <= prev.Total || cur.Busy < prev.Busy {
		return 0, false
	}
	return percent(100 * float64(cur.Busy-prev.Busy) / float64(cur.Total-prev.Total)), true
}

// memInfo holds the /proc/meminfo values the agent uses, in bytes.
type memInfo struct {
	Total, Available, SwapTotal, SwapFree uint64
}

func parseMeminfo(data []byte) (memInfo, error) {
	var m memInfo
	var free, buffers, cached, reclaimable uint64
	haveTotal, haveAvailable := false, false
	for len(data) > 0 {
		var line []byte
		line, data = nextLine(data)
		i := bytes.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		value, _ := nextField(line[i+1:])
		kb, err := parseUint(value)
		if err != nil {
			continue
		}
		b := kb * 1024
		switch string(line[:i]) {
		case "MemTotal":
			m.Total, haveTotal = b, true
		case "MemAvailable":
			m.Available, haveAvailable = b, true
		case "MemFree":
			free = b
		case "Buffers":
			buffers = b
		case "Cached":
			cached = b
		case "SReclaimable":
			reclaimable = b
		case "SwapTotal":
			m.SwapTotal = b
		case "SwapFree":
			m.SwapFree = b
		}
	}
	if !haveTotal || m.Total == 0 {
		return memInfo{}, errFormat
	}
	if !haveAvailable {
		// Kernels before 3.14 have no MemAvailable; this is the usual estimate.
		m.Available = free + buffers + cached + reclaimable
	}
	if m.Available > m.Total {
		m.Available = m.Total
	}
	return m, nil
}

func (m memInfo) memoryPercent() float64 {
	return percent(100 * (1 - float64(m.Available)/float64(m.Total)))
}

func (m memInfo) swapPercent() float64 {
	if m.SwapTotal == 0 {
		return 0
	}
	free := min(m.SwapFree, m.SwapTotal)
	return percent(100 * (1 - float64(free)/float64(m.SwapTotal)))
}

// parseLoadavg returns the 1, 5 and 15 minute load averages.
func parseLoadavg(data []byte) ([]float64, error) {
	out := make([]float64, 0, 3)
	rest := data
	for len(out) < 3 {
		var f []byte
		f, rest = nextField(rest)
		v, err := strconv.ParseFloat(string(f), 64)
		if err != nil {
			return nil, errFormat
		}
		out = append(out, round2(clamp(v, 0, maxLoad)))
	}
	return out, nil
}

// parseUptime returns the seconds since boot.
func parseUptime(data []byte) (float64, error) {
	f, _ := nextField(data)
	v, err := strconv.ParseFloat(string(f), 64)
	if err != nil {
		return 0, errFormat
	}
	return float64(int64(clamp(v, 0, maxUptime))), nil
}

// netCounters are the cumulative byte counters of one interface.
type netCounters struct {
	Name   string
	Rx, Tx uint64
}

// parseNetDev reads /proc/net/dev, skipping loopback and container/bridge plumbing so that
// traffic is not counted twice (once on the uplink and once on docker0 or a veth pair).
func parseNetDev(data []byte, into []netCounters) ([]netCounters, error) {
	into = into[:0]
	lines := 0
	for len(data) > 0 {
		var line []byte
		line, data = nextLine(data)
		lines++
		i := bytes.IndexByte(line, ':')
		if i < 0 {
			continue // the two header lines
		}
		name := string(bytes.TrimSpace(line[:i]))
		if name == "" || len(name) > maxIfaceLen || skipInterface(name) {
			continue
		}
		// receive: bytes packets errs drop fifo frame compressed multicast, then transmit: bytes …
		rest := line[i+1:]
		var rx, tx uint64
		ok := true
		for n := 0; n < 9; n++ {
			var f []byte
			f, rest = nextField(rest)
			v, err := parseUint(f)
			if err != nil {
				ok = false
				break
			}
			switch n {
			case 0:
				rx = v
			case 8:
				tx = v
			}
		}
		if !ok {
			continue
		}
		into = append(into, netCounters{Name: name, Rx: rx, Tx: tx})
	}
	if lines < 2 {
		return into, errFormat
	}
	return into, nil
}

var virtualInterfacePrefixes = []string{
	"veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "tunl", "kube-", "dummy",
	"lxcbr", "lxdbr", "podman", "vnet", "ifb", "sit", "ip6tnl", "gretap", "erspan",
}

func skipInterface(name string) bool {
	if name == "lo" {
		return true
	}
	for _, p := range virtualInterfacePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// diskCounters are the cumulative bytes read and written across whole disks.
type diskCounters struct {
	Read, Written uint64
}

// parseDiskstats sums sectors read/written over whole disks. isDisk decides whether a device
// name is a whole disk (so partitions and stacked devices are not counted twice).
func parseDiskstats(data []byte, isDisk func(name string) bool) (diskCounters, error) {
	var total diskCounters
	seen := false
	for len(data) > 0 {
		var line []byte
		line, data = nextLine(data)
		// major minor name reads merged sectorsRead msRead writes merged sectorsWritten …
		var f [10][]byte
		rest := line
		n := 0
		for n < len(f) {
			f[n], rest = nextField(rest)
			if len(f[n]) == 0 {
				break
			}
			n++
		}
		if n < 10 {
			continue
		}
		seen = true
		if !isDisk(string(f[2])) {
			continue
		}
		read, err1 := parseUint(f[5])
		written, err2 := parseUint(f[9])
		if err1 != nil || err2 != nil {
			continue
		}
		// /proc/diskstats always counts in 512-byte sectors, whatever the device's block size.
		total.Read += read * 512
		total.Written += written * 512
	}
	if !seen {
		return total, errFormat
	}
	return total, nil
}

// wholeDiskByName is the fallback when /sys/block cannot be listed: it recognises partitions by
// their naming pattern and skips virtual devices.
func wholeDiskByName(name string) bool {
	if skipBlockDevice(name) {
		return false
	}
	last := name[len(name)-1]
	endsInDigit := last >= '0' && last <= '9'
	switch {
	case strings.HasPrefix(name, "nvme"), strings.HasPrefix(name, "mmcblk"):
		// nvme0n1 and mmcblk0 are disks; nvme0n1p1 and mmcblk0p1 are partitions.
		i := strings.LastIndexByte(name, 'p')
		partition := i > 0 && allDigits(name[i+1:]) && name[i-1] >= '0' && name[i-1] <= '9'
		return !partition
	case strings.HasPrefix(name, "sd"), strings.HasPrefix(name, "vd"), strings.HasPrefix(name, "xvd"), strings.HasPrefix(name, "hd"):
		return !endsInDigit
	}
	return true
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// skipBlockDevice excludes devices that are not physical storage or that sit on top of other
// devices (their I/O is already counted on the disks underneath).
func skipBlockDevice(name string) bool {
	for _, p := range []string{"loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return name == ""
}

// mountEntry is one line of /proc/self/mountinfo.
type mountEntry struct {
	Device string // "major:minor"
	Path   string
	FSType string
}

// parseMountinfo returns the real, local filesystems: pseudo and network filesystems are
// skipped, and a filesystem mounted in several places (bind mounts, btrfs subvolumes, systemd's
// private mounts for the service) is listed once, at its shortest mount point.
func parseMountinfo(data []byte) []mountEntry {
	var out []mountEntry
	index := map[string]int{}
	for len(data) > 0 {
		var line []byte
		line, data = nextLine(data)
		// id parent major:minor root mountpoint options [optional…] - fstype source superoptions
		sep := bytes.Index(line, []byte(" - "))
		if sep < 0 {
			continue
		}
		var f [5][]byte
		rest := line[:sep]
		n := 0
		for n < len(f) {
			f[n], rest = nextField(rest)
			if len(f[n]) == 0 {
				break
			}
			n++
		}
		if n < 5 {
			continue
		}
		fstype, _ := nextField(line[sep+3:])
		path := unescapeMount(string(f[4]))
		if skipFilesystem(string(fstype)) || skipMountPath(path) || len(path) > maxPathLen {
			continue
		}
		device := string(f[2])
		if i, dup := index[device]; dup {
			if len(path) < len(out[i].Path) {
				out[i].Path = path
			}
			continue
		}
		index[device] = len(out)
		out = append(out, mountEntry{Device: device, Path: path, FSType: string(fstype)})
	}
	return out
}

// unescapeMount decodes the octal escapes the kernel uses for spaces and similar in mount paths.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

var pseudoFilesystems = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true, "ramfs": true,
	"cgroup": true, "cgroup2": true, "pstore": true, "bpf": true, "debugfs": true, "tracefs": true,
	"securityfs": true, "configfs": true, "fusectl": true, "mqueue": true, "hugetlbfs": true,
	"autofs": true, "binfmt_misc": true, "rpc_pipefs": true, "efivarfs": true, "selinuxfs": true,
	"nsfs": true, "squashfs": true, "iso9660": true, "udf": true, "rootfs": true, "overlayfs": true,
	"sockfs": true, "pipefs": true, "anon_inodefs": true, "nfsd": true, "fuse.lxcfs": true,
	"fuse.gvfsd-fuse": true, "fuse.portal": true, "fuse.snapfuse": true, "erofs": true,
}

// Network filesystems are skipped on purpose: statfs on an unreachable NFS or CIFS server can
// block for minutes, and the agent must never hang because of someone else's file server.
var networkFilesystems = map[string]bool{
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "smbfs": true, "fuse.sshfs": true,
	"ceph": true, "glusterfs": true, "fuse.glusterfs": true, "afs": true, "ncpfs": true, "9p": true,
	"lustre": true, "gfs2": true, "ocfs2": true, "davfs": true, "fuse.rclone": true, "fuse.s3fs": true,
}

func skipFilesystem(fstype string) bool {
	return fstype == "" || pseudoFilesystems[fstype] || networkFilesystems[fstype]
}

var skippedMountPrefixes = []string{
	"/proc", "/sys", "/dev", "/run", "/snap", "/var/snap",
	"/var/lib/docker", "/var/lib/containers", "/var/lib/containerd", "/var/lib/kubelet",
	"/var/lib/lxcfs", "/boot/efi",
}

func skipMountPath(path string) bool {
	if path == "" || path[0] != '/' {
		return true
	}
	switch path {
	case "/etc/resolv.conf", "/etc/hostname", "/etc/hosts":
		return true // single files that container runtimes bind-mount from the host
	}
	for _, p := range skippedMountPrefixes {
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}

// procStat is the part of /proc/<pid>/stat the agent uses.
type procStat struct {
	PID       int
	Name      [16]byte
	NameLen   int
	Ticks     uint64 // utime + stime, in clock ticks
	StartTime uint64 // clock ticks after boot; tells a recycled pid from the old process
	RSSPages  uint64
}

// parseProcStat parses one /proc/<pid>/stat line. The command name sits in parentheses and may
// itself contain spaces and parentheses, so the fields are located from the last ')'.
func parseProcStat(data []byte) (procStat, error) {
	var p procStat
	open := bytes.IndexByte(data, '(')
	closing := bytes.LastIndexByte(data, ')')
	if open < 1 || closing < open {
		return p, errFormat
	}
	pid, err := parseUint(bytes.TrimSpace(data[:open]))
	if err != nil || pid > 1e9 {
		return p, errFormat
	}
	p.PID = int(pid)
	p.NameLen = copy(p.Name[:], data[open+1:closing])
	// After ')': state(3) ppid(4) … utime(14) stime(15) … starttime(22) vsize(23) rss(24)
	rest := data[closing+1:]
	for field := 3; field <= 24; field++ {
		var f []byte
		f, rest = nextField(rest)
		if len(f) == 0 {
			return p, errFormat
		}
		switch field {
		case 14, 15, 22, 24:
			v, err := parseUint(f)
			if err != nil {
				if field == 24 {
					v = 0 // rss is signed in the kernel's format string
				} else {
					return p, errFormat
				}
			}
			switch field {
			case 14, 15:
				p.Ticks += v
			case 22:
				p.StartTime = v
			case 24:
				p.RSSPages = v
			}
		}
	}
	return p, nil
}

// parseOSRelease returns PRETTY_NAME (or NAME + VERSION) from /etc/os-release.
func parseOSRelease(data []byte) string {
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		values[key] = value
	}
	name := values["PRETTY_NAME"]
	if name == "" {
		name = strings.TrimSpace(values["NAME"] + " " + values["VERSION"])
	}
	if len(name) > 100 {
		name = name[:100]
	}
	return name
}
